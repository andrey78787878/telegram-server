const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
const { google } = require('googleapis');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = 3000;

// ====== Настройки ======
const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";
const SPREADSHEET_ID = '1u48GTrioEVs_3P3fxcX0e7pKZmYwZyE8HioWJHgRZTc'; // <- Замените при необходимости
const SHEET_NAME = 'Заявки';
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

const httpsAgent = new https.Agent({ rejectUnauthorized: false }); // ⚠ Только для отладки

// ====== Middleware ======
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ====== Авторизация Google ======
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

// ====== Хранилище multer для временных файлов ======
const upload = multer({ dest: 'uploads/' });

// ====== Удаление сообщений через 60 секунд ======
const scheduleDeletion = (chatId, messageId) => {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    }, { httpsAgent }).catch(err => {
      console.error('Ошибка при удалении сообщения:', err.response?.data || err.message);
    });
  }, 60000);
};

// ====== Хендлер Webhook от Telegram ======
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.message) {
      const chatId = body.message.chat.id;
      const text = body.message.text;

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `Вы отправили: ${text}`,
      }, { httpsAgent });

      scheduleDeletion(chatId, body.message.message_id);
      scheduleDeletion(chatId, sent.data.result.message_id);
    }

    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const data = body.callback_query.data;

      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: body.callback_query.id,
      }, { httpsAgent });

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `Вы нажали: ${data}`,
      }, { httpsAgent });

      scheduleDeletion(chatId, messageId);
      scheduleDeletion(chatId, sent.data.result.message_id);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка в /webhook:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// ====== Загрузка фото и запись в Google Таблицу ======
app.post('/upload', upload.single('photo'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const fileMetadata = {
      name: req.file.originalname,
      parents: [FOLDER_ID],
    };
    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(filePath),
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });

    const fileId = file.data.id;

    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });

    const publicUrl = `https://drive.google.com/uc?id=${fileId}`;
    const rowIndex = req.body.row;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!O${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[publicUrl]],
      },
    });

    fs.unlinkSync(filePath);
    res.status(200).send('Файл загружен и ссылка записана');
  } catch (err) {
    console.error('Ошибка в /upload:', err.response?.data || err.message);
    res.status(500).send('Ошибка при загрузке файла');
  }
});

// ====== Запуск сервера ======
app.get('/', (req, res) => {
  res.send('Бот работает!');
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
