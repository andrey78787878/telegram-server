require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const FOLDER_ID = process.env.FOLDER_ID;

// Авторизация в Google Drive API
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json', // Убедитесь, что файл существует
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const driveService = google.drive({ version: 'v3', auth });

// Загружаем фото на Google Диск
async function uploadToDrive(filePath, fileName) {
  const fileMetadata = {
    name: fileName,
    parents: [FOLDER_ID],
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath),
  };

  const file = await driveService.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });

  await driveService.permissions.create({
    fileId: file.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return `https://drive.google.com/uc?id=${file.data.id}`;
}

// Получение file_path по file_id
async function getTelegramFilePath(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return res.data.result.file_path;
}

// Скачивание фото и загрузка на диск
async function handlePhoto(photo, message_id, username, row) {
  try {
    const fileId = photo[photo.length - 1].file_id;
    const filePath = await getTelegramFilePath(fileId);
    const url = `${TELEGRAM_FILE_API}/${filePath}`;
    const fileName = `${Date.now()}_${message_id}.jpg`;
    const tempPath = path.join(__dirname, fileName);

    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const driveLink = await uploadToDrive(tempPath, fileName);
    fs.unlinkSync(tempPath);

    await axios.post(GAS_WEB_APP_URL, {
      photo: driveLink,
      message_id,
      username,
      row,
    });

    console.log(`Фотография загружена и отправлена в таблицу: ${driveLink}`);
  } catch (err) {
    console.error('Ошибка при загрузке фото:', err.message);
  }
}

// Обработка callback кнопок
app.post('/webhook', async (req, res) => {
  console.log('Incoming update:', JSON.stringify(req.body, null, 2));
  const body = req.body;

  if (body.message && body.message.photo) {
    const message = body.message;
    const caption = message.caption || '';
    const [_, message_id, row] = caption.split('|');
    const username = message.from.username || 'unknown';

    await handlePhoto(message.photo, message_id, username, row);
  }

  if (body.callback_query) {
    const query = body.callback_query;
    const data = query.data;
    const chat_id = query.message.chat.id;
    const message_id = query.message.message_id;
    const username = query.from.username || 'unknown';

    if (data.startsWith('in_progress_')) {
      const row = data.split('_')[2];
      await axios.post(GAS_WEB_APP_URL, {
        message_id,
        status: 'В работе',
        username,
      });

      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id,
        message_id,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Выполнено ✅', callback_data: 'done' },
              { text: 'Отмена ❌', callback_data: 'cancel' },
            ],
          ],
        },
      });
    }

    if (data === 'done') {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `📸 Отправьте фото выполненной работы (в одном сообщении).`,
        reply_to_message_id: message_id,
      });
    }

    if (data === 'cancel') {
      await axios.post(GAS_WEB_APP_URL, {
        message_id,
        status: 'Отменено',
        username,
      });

      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id,
        message_id,
        text: `❌ Заявка отменена исполнителем @${username}`,
      });
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
