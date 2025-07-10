require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const GAS_UPLOAD_URL = process.env.GAS_UPLOAD_URL;

const PORT = process.env.PORT || 3000;

const userSessions = {};

function sendTelegramMessage(chat_id, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

function editTelegramMessage(chat_id, message_id, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id,
    message_id,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

function deleteMessage(chat_id, message_id) {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id,
    message_id,
  });
}

async function uploadPhotoToDrive(file_id) {
  const { data: fileInfo } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
  const filePath = fileInfo.result.file_path;
  const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
  const response = await axios.get(fileUrl, { responseType: 'stream' });

  const formData = new FormData();
  formData.append('photo', response.data, 'photo.jpg');

  const uploadRes = await axios.post(GAS_UPLOAD_URL, formData, {
    headers: formData.getHeaders(),
  });

  return uploadRes.data.photoUrl;
}

// Обработка входящих обновлений
app.post(`/webhook`, async (req, res) => {
  const body = req.body;

  if (body.message) {
    const msg = body.message;
    const chat_id = msg.chat.id;
    const user_id = msg.from.id;
    const username = msg.from.username || `${msg.from.first_name} ${msg.from.last_name || ''}`;
    const text = msg.text;
    const photo = msg.photo;

    if (userSessions[user_id]?.expecting === 'photo') {
      const file_id = photo?.[photo.length - 1]?.file_id;
      if (!file_id) return;

      try {
        const photoUrl = await uploadPhotoToDrive(file_id);
        userSessions[user_id].photoUrl = photoUrl;
        userSessions[user_id].expecting = 'sum';
        sendTelegramMessage(chat_id, '💰 Введите сумму:');
      } catch (err) {
        sendTelegramMessage(chat_id, 'Ошибка при загрузке фото.');
      }
      return;
    }

    if (userSessions[user_id]?.expecting === 'sum') {
      userSessions[user_id].sum = text;
      userSessions[user_id].expecting = 'comment';
      sendTelegramMessage(chat_id, '✍️ Введите комментарий:');
      return;
    }

    if (userSessions[user_id]?.expecting === 'comment') {
      userSessions[user_id].comment = text;
      userSessions[user_id].expecting = null;

      const { row, message_id, photoUrl, sum, comment, executor } = userSessions[user_id];

      await axios.post(GAS_WEB_APP_URL, {
        row,
        photo: photoUrl,
        sum,
        comment,
        username: executor,
        message_id,
        status: 'Выполнено',
      });

      const deadlineText = userSessions[user_id].overdue || '—';
      const summaryText = `
📌 Заявка #${row} закрыта.
📎 Фото: <a href="${photoUrl}">ссылка</a>
💰 Сумма: ${sum} сум
👤 Исполнитель: @${executor}
✅ Статус: Выполнено
Просрочка: ${deadlineText}
      `.trim();

      await editTelegramMessage(chat_id, message_id, summaryText);
      sendTelegramMessage(chat_id, `✅ Заявка #${row} закрыта. Спасибо!`);

      delete userSessions[user_id];
      return;
    }
  }

  if (body.callback_query) {
    const cb = body.callback_query;
    const data = cb.data;
    const chat_id = cb.message.chat.id;
    const message_id = cb.message.message_id;
    const user_id = cb.from.id;
    const username = cb.from.username || `${cb.from.first_name} ${cb.from.last_name || ''}`;

    const [action, row] = data.split('_');

    if (action === 'start') {
      await axios.post(GAS_WEB_APP_URL, {
        row,
        status: 'В работе',
        executor: username,
        message_id,
      });

      const newButtons = {
        inline_keyboard: [[
          { text: '✅ Выполнено', callback_data: `done_${row}` },
          { text: '🚚 Ожидает поставки', callback_data: `wait_${row}` },
          { text: '❌ Отмена', callback_data: `cancel_${row}` },
        ]],
      };

      await editTelegramMessage(chat_id, message_id, `👷 Заявка #${row} принята в работу исполнителем: @${username}`, {
        reply_markup: newButtons,
      });

      return res.sendStatus(200);
    }

    if (action === 'done') {
      userSessions[user_id] = {
        expecting: 'photo',
        row,
        message_id,
        executor: username,
        overdue: '', // можно дополнить данными из таблицы при необходимости
      };
      sendTelegramMessage(chat_id, '📷 Отправьте фото выполненных работ:');
      return res.sendStatus(200);
    }

    if (action === 'wait' || action === 'cancel') {
      const statusMap = {
        wait: 'Ожидает поставки',
        cancel: 'Отмена',
      };
      const status = statusMap[action];

      await axios.post(GAS_WEB_APP_URL, {
        row,
        status,
        executor: username,
        message_id,
      });

      await editTelegramMessage(chat_id, message_id, `🔄 Заявка #${row}: ${status} @${username}`);
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

// Установка webhook
app.get('/setWebhook', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/webhook`;
  const response = await axios.get(`${TELEGRAM_API}/setWebhook?url=${url}`);
  res.json(response.data);
});

app.listen(PORT, () => {
  console.log(`Telegram Bot Server running on port ${PORT}`);
});
