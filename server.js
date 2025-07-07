require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

const userStates = {}; // userId -> { stage, row, messageId, ... }

app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    if (body.callback_query) {
      const callbackData = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = body.callback_query.from.username || body.callback_query.from.first_name;

      if (/^in_progress_\d+$/.test(callbackData)) {
        const row = callbackData.split('_')[2];

        await axios.post(GAS_WEB_APP_URL, {
          row,
          status: 'В работе',
          executor: username
        });

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Выполнено ✅', callback_data: `done_${row}` },
              { text: 'Ожидает поставки 📦', callback_data: `supply_${row}` },
              { text: 'Отмена ❌', callback_data: `cancel_${row}` }
            ]]
          }
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Заявка #${row} принята в работу исполнителем @${username}`,
          reply_to_message_id: messageId
        });
      }

      else if (/^done_\d+$/.test(callbackData)) {
        const row = callbackData.split('_')[1];
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username, messagesToDelete: [] };

        const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '📷 Пожалуйста, отправьте фото выполненной работы.'
        });
        userStates[chatId].messagesToDelete.push(msg.data.result.message_id);
      }

      else if (/^cancel_\d+$/.test(callbackData)) {
        const row = callbackData.split('_')[1];
        await axios.post(GAS_WEB_APP_URL, {
          row,
          status: 'Отменено',
          executor: username
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `❌ Заявка #${row} отменена.`
        });
      }
    }
    else if (body.message && userStates[body.message.chat.id]) {
      const state = userStates[body.message.chat.id];
      const chatId = body.message.chat.id;
      const msg = body.message;

      if (state.stage === 'awaiting_photo' && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

        state.photoUrl = fileUrl;
        state.stage = 'awaiting_sum';

        const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '💰 Укажите сумму выполненных работ (в сумах):'
        });
        state.messagesToDelete.push(m.data.result.message_id);
      }
      else if (state.stage === 'awaiting_sum' && msg.text) {
        state.sum = msg.text;
        state.stage = 'awaiting_comment';

        const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '💬 Добавьте комментарий к заявке:'
        });
        state.messagesToDelete.push(m.data.result.message_id);
      }
      else if (state.stage === 'awaiting_comment' && msg.text) {
        state.comment = msg.text;

        await axios.post(GAS_WEB_APP_URL, {
          row: state.row,
          photo: state.photoUrl,
          sum: state.sum,
          comment: state.comment,
          username: state.username,
          message_id: state.messageId,
          status: 'Выполнено'
        });

        const finalMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `📌 Заявка #${state.row} закрыта.\n📎 Фото: [ссылка](${state.photoUrl})\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: @${state.username}\n✅ Статус: Выполнено`,
          parse_mode: 'Markdown'
        });
        state.messagesToDelete.push(finalMsg.data.result.message_id);

        setTimeout(() => {
          state.messagesToDelete.forEach(async msgId => {
            try {
              await axios.post(`${TELEGRAM_API}/deleteMessage`, {
                chat_id: chatId,
                message_id: msgId
              });
            } catch (err) {
              console.warn(`[deleteMessage Error]:`, err.response?.data || err.message);
            }
          });
        }, 60000);

        delete userStates[chatId];
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook Error]:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
