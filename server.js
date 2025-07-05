const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
app.use(bodyParser.json());

const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

const GAS_URL = 'https://script.google.com/macros/s/AKfycbxeXikOhZy-HlXNTh4Dpz7FWqBf1pRi6DWpzGQlFQr8TSV46KUU_-FJF976oQrxpHAx/exec';

const FOLDER_ID = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';
const SERVICE_ACCOUNT = require('./service_account.json');

const auth = new google.auth.GoogleAuth({
  credentials: SERVICE_ACCOUNT,
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

const chats = new Map();

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.message) {
    const msg = body.message;
    const chatId = msg.chat.id;

    if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const row = chats.get(chatId)?.row;
      if (!row) return res.sendStatus(200);

      const fileUrl = await getTelegramFileUrl(fileId);
      const photoBuffer = await axios.get(fileUrl, { responseType: 'arraybuffer' }).then(r => r.data);

      const fileName = `photo_${Date.now()}.jpg`;
      const fileMetadata = {
        name: fileName,
        parents: [FOLDER_ID],
      };
      const media = {
        mimeType: 'image/jpeg',
        body: Readable.from(photoBuffer),
      };

      const uploadRes = await drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id',
      });

      const fileIdDrive = uploadRes.data.id;

      await drive.permissions.create({
        fileId: fileIdDrive,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const publicUrl = `https://drive.google.com/uc?id=${fileIdDrive}`;
      chats.get(chatId).photo = publicUrl;

      await sendMessage(chatId, 'Введите сумму работ в сумах:');
    } else if (msg.text && /^\d+$/.test(msg.text)) {
      if (!chats.has(chatId)) return res.sendStatus(200);
      chats.get(chatId).sum = msg.text;
      await sendMessage(chatId, 'Добавьте комментарий:');
    } else if (msg.text) {
      if (!chats.has(chatId)) return res.sendStatus(200);
      const { row, photo, sum, username, message_id } = chats.get(chatId);
      const comment = msg.text;

      const payload = {
        row,
        photo,
        sum,
        comment,
        username,
        message_id,
      };

      await axios.post(GAS_URL, payload);
      await sendMessage(chatId, `Заявка #${row} закрыта. 💰 Сумма: ${sum} сум 👤 Исполнитель: @${username}`);
      chats.delete(chatId);
    }
  } else if (body.callback_query) {
    const query = body.callback_query;
    const chatId = query.message.chat.id;
    const data = query.data;
    const username = query.from.username;
    const message_id = query.message.message_id;

    const rowMatch = data.match(/_(\d+)/);
    const row = rowMatch ? rowMatch[1] : null;
    if (!row) return res.sendStatus(200);

    if (data.startsWith('work_')) {
      await editInlineKeyboard(chatId, message_id, username);
      await axios.post(GAS_URL, { row, status: 'В работе', username, message_id });
    }
    if (data.startsWith('done_')) {
      chats.set(chatId, { row, username, message_id });
      await sendMessage(chatId, 'Загрузите фото выполненных работ:');
    }
    if (data.startsWith('wait_')) {
      await sendMessage(chatId, 'Заявка ожидает поставки.');
      await axios.post(GAS_URL, { row, status: 'Ожидает поставки', username, message_id });
    }
    if (data.startsWith('cancel_')) {
      await sendMessage(chatId, 'Заявка отменена.');
      await axios.post(GAS_URL, { row, status: 'Отменена', username, message_id });
    }
  }

  res.sendStatus(200);
});

async function getTelegramFileUrl(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${res.data.result.file_path}`;
}

async function sendMessage(chatId, text) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

async function editInlineKeyboard(chatId, messageId, username) {
  return axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Выполнено', callback_data: `done_${messageId}` },
        { text: '📦 Ожидает поставки', callback_data: `wait_${messageId}` },
        { text: '❌ Отмена', callback_data: `cancel_${messageId}` }
      ]],
    },
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
