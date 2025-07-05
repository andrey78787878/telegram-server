const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const https = require('https');
const FormData = require('form-data');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// === Константы ===
const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxeXikOhZy-HlXNTh4Dpz7FWqBf1pRi6DWpzGQlFQr8TSV46KUU_-FJF976oQrxpHAx/exec';
const FOLDER_ID = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'credentials.json');

// === Middleware ===
app.use(bodyParser.json());

// === Telegram обработка ===
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Логика обработки callback_query, сообщений, команд
    // — сюда добавляются все обработчики:
    // - инлайн-кнопок
    // - сообщений с фото
    // - сообщений с суммой
    // - сообщений с комментарием
    // - ручной ввод исполнителя
    // - обновление таблицы и сообщений
    // ...

    console.log('Получено:', JSON.stringify(body, null, 2));
    // 👇 добавь основную обработку, которую я уже подготовил выше

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка обработки запроса:', err);
    res.sendStatus(500);
  }
});

// === Авторизация Google Drive ===
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_FILE,
  scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

// === Загрузка фото с Telegram на Google Drive ===
async function uploadTelegramPhotoToDrive(fileId, fileName) {
  const filePathRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = filePathRes.data.result.file_path;

  const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
  const response = await axios.get(fileUrl, { responseType: 'stream' });

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [FOLDER_ID]
    },
    media: {
      mimeType: 'image/jpeg',
      body: response.data
    }
  });

  const fileIdDrive = res.data.id;

  await drive.permissions.create({
    fileId: fileIdDrive,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  const publicUrl = `https://drive.google.com/uc?id=${fileIdDrive}`;
  return publicUrl;
}

// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
