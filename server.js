require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const app = express();
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

const state = new Map(); // Храним временные состояния диалогов (ожидание фото/суммы/комментария)

// 🔔 Обработка вебхука от Telegram
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // 🔹 Обработка inline кнопок
    if (body.callback_query) {
      const callbackData = body.callback_query.data;
      const [action, row, msgId] = callbackData.split(':');
      const chat_id = body.callback_query.message.chat.id;
      const username = body.callback_query.from.username || 'Без username';

      if (action === 'in_progress') {
        await axios.post(GAS_WEB_APP_URL, {
          action: 'inProgress',
          row,
          message_id: msgId,
          username
        });

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id,
          message_id: msgId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🟢 В работе', callback_data: 'noop' }
              ],
              [
                { text: '✅ Выполнено', callback_data: `done:${row}:${msgId}` },
                { text: '🕓 Ожидает поставки', callback_data: `awaiting:${row}:${msgId}` },
                { text: '❌ Отмена', callback_data: `cancel:${row}:${msgId}` }
              ]
            ]
          }
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `👤 Заявка №${row} закреплена за @${username}`
        });
      }

      if (action === 'done') {
        state.set(chat_id, { stage: 'waiting_photo', row, msgId, username });
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: '📷 Пожалуйста, отправьте фото выполненных работ'
        });
      }

      return res.sendStatus(200);
    }

    // 🔹 Обработка фото, суммы, комментария
    const message = body.message;
    if (message) {
      const chat_id = message.chat.id;
      const userState = state.get(chat_id);

      if (!userState) return res.sendStatus(200);

      // ⬇️ Фото
      if (userState.stage === 'waiting_photo' && message.photo) {
        const file_id = message.photo[message.photo.length - 1].file_id;
        const fileResp = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
        const filePath = fileResp.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
        userState.photo_url = fileUrl;
        userState.stage = 'waiting_sum';

        state.set(chat_id, userState);

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: '💰 Укажите сумму выполненных работ (в сум)'
        });

        return res.sendStatus(200);
      }

      // ⬇️ Сумма
      if (userState.stage === 'waiting_sum' && message.text) {
        const sum = message.text;
        if (isNaN(sum)) {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id,
            text: '❗ Пожалуйста, укажите сумму числом'
          });
          return res.sendStatus(200);
        }

        userState.sum = sum;
        userState.stage = 'waiting_comment';
        state.set(chat_id, userState);

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: '📝 Добавьте комментарий'
        });

        return res.sendStatus(200);
      }

      // ⬇️ Комментарий
      if (userState.stage === 'waiting_comment' && message.text) {
        const comment = message.text;
        userState.comment = comment;

        // Отправляем все в GAS
        await axios.post(GAS_WEB_APP_URL, {
          action: 'completed',
          row: userState.row,
          message_id: userState.msgId,
          photo: userState.photo_url,
          sum: userState.sum,
          comment: userState.comment,
          username: userState.username
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `✅ Заявка #${userState.row} закрыта.\n💰 Сумма: ${userState.sum} сум\n👤 Исполнитель: @${userState.username}`
        });

        state.delete(chat_id);
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Ошибка в /webhook:', error.message);
    res.sendStatus(500);
  }
});

// 🔁 Получение формы от Google Таблицы
app.post('/sendForm', async (req, res) => {
  try {
    const { text, row } = req.body;

    if (!text || !row) {
      return res.status(400).json({ error: 'Недостаточно данных: нужен text и row' });
    }

    const resp = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: process.env.CHAT_ID,
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Принято в работу', callback_data: `in_progress:${row}:${row}` }
        ]]
      }
    });

    const message_id = resp.data.result.message_id;

    await axios.post(GAS_WEB_APP_URL, {
      action: 'getMessageId',
      row,
      message_id
    });

    res.json({ success: true, message_id });
  } catch (err) {
    console.error('❌ Ошибка в /sendForm:', err.message);
    res.status(500).json({ error: 'Ошибка при отправке формы' });
  }
});

// ▶️ Старт сервера
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
