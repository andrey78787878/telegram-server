// server.js
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwn2n371K5QiB4E-9oxAvYSlhFo2REweegLEqgTjtfLqB689qUQR2VHWhzzv4oJkPKl/exec';
const DRIVE_FOLDER_ID = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';

const app = express();
app.use(bodyParser.json());

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const KEYFILEPATH = path.join(__dirname, 'service-account.json');
const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILEPATH,
  scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });

const sumRequests = new Map();
const photoRequests = new Map();
const tempMessages = new Map();

app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('📥 Incoming:', JSON.stringify(body));

  if (body.callback_query) {
    const data = body.callback_query.data;
    const chatId = body.callback_query.message.chat.id;
    const msgId = body.callback_query.message.message_id;
    const row = parseInt(data.split(':')[1]);
    const action = data.split(':')[0];
    const username = body.callback_query.from.username ? `@${body.callback_query.from.username}` : body.callback_query.from.first_name;

    if (action === 'done') {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: `📸 Пожалуйста, отправьте фото выполненной работы.`
      });

      photoRequests.set(chatId, { row, msgId });
    }

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
      callback_query_id: body.callback_query.id
    });
    return res.sendStatus(200);
  }

  if (body.message && body.message.photo && photoRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const { row, msgId } = photoRequests.get(chatId);
    const fileId = body.message.photo.pop().file_id;
    const user = body.message.from;
    const username = user.username ? `@${user.username}` : user.first_name;

    try {
      const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

      const response = await axios.get(fileUrl, { responseType: 'stream' });
      const uploadRes = await drive.files.create({
        requestBody: {
          name: `photo_${Date.now()}.jpg`,
          parents: [DRIVE_FOLDER_ID],
        },
        media: {
          mimeType: 'image/jpeg',
          body: response.data,
        },
      });

      await drive.permissions.create({
        fileId: uploadRes.data.id,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
      });

      const photoLink = `https://drive.google.com/uc?id=${uploadRes.data.id}`;

      await axios.post(WEB_APP_URL, {
        row,
        response: 'Выполнено',
        photo: photoLink,
        username,
        message_id: msgId
      });

      sumRequests.set(chatId, { row, msgId, fileUrl: photoLink, username });
      photoRequests.delete(chatId);

      const reply = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: `📩 Фото получено для заявки #${row}. Пожалуйста, введите сумму работ.`
      });

      tempMessages.set(chatId, [body.message.message_id, reply.data.result.message_id]);
      return res.sendStatus(200);
    } catch (error) {
      console.error('Ошибка при загрузке фото:', error);
      return res.sendStatus(500);
    }
  }

  if (body.message && body.message.text && sumRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const amount = body.message.text.trim();
    const { row, msgId, fileUrl, username } = sumRequests.get(chatId);

    await axios.post(WEB_APP_URL, {
      row,
      amount,
      photo: fileUrl,
      username,
      message_id: msgId
    });

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Заявка #${row} закрыта.\n💰 Сумма: ${amount} сум\n👤 Исполнитель: ${username}`
    });

    const msgIds = tempMessages.get(chatId) || [];
    for (const id of msgIds) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
        chat_id: chatId,
        message_id: id
      });
    }

    sumRequests.delete(chatId);
    tempMessages.delete(chatId);
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log('✅ Сервер запущен на порту 3000');
});
