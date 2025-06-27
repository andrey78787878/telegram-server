require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Загрузка сервисного аккаунта
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json',
  scopes: ['https://www.googleapis.com/auth/drive.file']
});

const drive = google.drive({ version: 'v3', auth });

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.callback_query) {
    const callback = body.callback_query;
    const [action, row] = callback.data.split(':');
    const message_id = callback.message.message_id;
    const chat_id = callback.message.chat.id;
    const username = callback.from.username;

    const responseMap = {
      accepted: 'Принято в работу',
      in_progress: 'В процессе',
      waiting: 'Ожидает поставки',
      cancel: 'Отмена',
      done: 'Выполнено'
    };

    const responseText = responseMap[action] || 'Статус неизвестен';

    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callback.id,
      text: `Вы выбрали: ${responseText}`
    });

    if (action === 'done') {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '📸 Пожалуйста, загрузите фото выполненных работ.'
      });
    }

    await axios.post(GOOGLE_SCRIPT_URL, {
      row,
      message_id,
      username,
      response: responseText
    });
  }

  if (body.message && body.message.photo) {
    const chat_id = body.message.chat.id;
    const username = body.message.from.username;
    const message_id = body.message.message_id;
    const photo = body.message.photo[body.message.photo.length - 1];

    const file_id = photo.file_id;
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
    const file_path = fileRes.data.result.file_path;
    const fileUrl = `${TELEGRAM_FILE_API}/${file_path}`;

    const fileName = `photo_${uuidv4()}.jpg`;
    const tempPath = path.join(__dirname, fileName);

    const writer = fs.createWriteStream(tempPath);
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const fileMetadata = {
      name: fileName,
      parents: [FOLDER_ID]
    };

    const media = {
      mimeType: 'image/jpeg',
      body: fs.createReadStream(tempPath)
    };

    const fileUpload = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id'
    });

    const fileId = fileUpload.data.id;
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    const publicUrl = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

    await axios.post(GOOGLE_SCRIPT_URL, {
      row: null,
      message_id,
      username,
      photo: publicUrl,
      response: 'Выполнено'
    });

    fs.unlinkSync(tempPath);
  }

  res.sendStatus(200);
});

// Пример отправки сообщения с кнопками (если нужно):
async function sendMessageWithButtons(chat_id, row) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: '🟢 Принято в работу', callback_data: `accepted:${row}` },
        { text: '🔄 В процессе', callback_data: `in_progress:${row}` },
      ],
      [
        { text: '⏳ Ожидает поставки', callback_data: `waiting:${row}` },
        { text: '❌ Отмена', callback_data: `cancel:${row}` },
      ],
      [
        { text: '✅ Выполнено', callback_data: `done:${row}` },
      ]
    ]
  };

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text: '📋 Заявка создана. Выберите статус:',
    reply_markup: keyboard
  });
}

app.listen(3000, () => {
  console.log('✅ Сервер запущен на порту 3000');
});
