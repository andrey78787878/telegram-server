// server.js — основной сервер Telegram-бота с обработкой заявок и состояний

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

// Состояния пользователей: userId -> { stage, row, messageId }
const userStates = {};

// Получение обновлений от Telegram
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // --- Обработка нажатия кнопки ---
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
      userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username };

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '📷 Пожалуйста, отправьте фото выполненной работы.'
      });
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

  // --- Обработка сообщений от пользователя ---
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

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '💰 Укажите сумму выполненных работ (в сумах):'
      });
    }
    else if (state.stage === 'awaiting_sum' && msg.text) {
      state.sum = msg.text;
      state.stage = 'awaiting_comment';

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '💬 Добавьте комментарий к заявке:'
      });
    }
    else if (state.stage === 'awaiting_comment' && msg.text) {
      state.comment = msg.text;

      // Отправка всех данных в GAS
      await axios.post(GAS_WEB_APP_URL, {
        row: state.row,
        photo: state.photoUrl,
        sum: state.sum,
        comment: state.comment,
        username: state.username,
        message_id: state.messageId,
        status: 'Выполнено'
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `📌 Заявка #${state.row} закрыта.\n📎 Фото: [ссылка](${state.photoUrl})\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: @${state.username}\n✅ Статус: Выполнено`,
        parse_mode: 'Markdown'
      });

      delete userStates[chatId];
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
