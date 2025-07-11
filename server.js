require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const CHAT_ID = process.env.CHAT_ID || '-1002582747660';

let userStates = {};

async function sendMessage(chatId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...options,
  });
}

async function editMessage(chatId, messageId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...options,
  });
}

async function deleteMessage(chatId, messageId) {
  await axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function downloadFile(fileId, dest) {
  const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = data.result.file_path;
  const url = `${TELEGRAM_FILE_API}/${filePath}`;
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(dest));
    writer.on('error', reject);
  });
}

async function uploadToDrive(filePath, fileName) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const fileMetadata = { name: fileName, parents: [GOOGLE_DRIVE_FOLDER_ID] };
  const media = { mimeType: 'image/jpeg', body: fs.createReadStream(filePath) };
  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    if (body.callback_query) {
      const callback = body.callback_query;
      const chatId = callback.message.chat.id;
      const messageId = callback.message.message_id;
      const data = callback.data;
      const username = callback.from.username || callback.from.first_name;

      const match = callback.message.text.match(/#(\d+)/);
      const row = match ? match[1] : null;

      if (!row) return res.sendStatus(200);

      if (data === 'accept') {
        await editMessage(chatId, messageId, `✅ Принято в работу исполнителем @${username}`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Выполнено', callback_data: 'done' }],
              [{ text: '⏳ Ожидает поставки', callback_data: 'delayed' }],
              [{ text: '❌ Отмена', callback_data: 'cancel' }],
            ],
          },
        });

        await axios.post(GAS_WEB_APP_URL, {
          message_id: messageId,
          row,
          status: 'В работе',
          executor: `@${username}`,
        });

      } else if (data === 'done') {
        userStates[chatId] = { step: 'awaiting_photo', messageId, row, username };
        await sendMessage(chatId, 'Пожалуйста, пришлите фото выполненной работы:');
      }

      return res.sendStatus(200);
    }

    if (body.message && userStates[body.message.chat.id]) {
      const state = userStates[body.message.chat.id];
      const chatId = body.message.chat.id;
      const row = state.row;
      const username = state.username;
      const messageId = state.messageId;

      if (state.step === 'awaiting_photo' && body.message.photo) {
        const fileId = body.message.photo.slice(-1)[0].file_id;
        const tempPath = path.join(__dirname, 'temp.jpg');
        await downloadFile(fileId, tempPath);
        const photoUrl = await uploadToDrive(tempPath, `Заявка_${row}.jpg`);
        fs.unlinkSync(tempPath);
        state.photoUrl = photoUrl;
        state.step = 'awaiting_sum';
        await sendMessage(chatId, 'Теперь введите сумму:');
        return res.sendStatus(200);
      }

      if (state.step === 'awaiting_sum' && body.message.text) {
        state.sum = body.message.text.trim();
        state.step = 'awaiting_comment';
        await sendMessage(chatId, 'Введите комментарий:');
        return res.sendStatus(200);
      }

      if (state.step === 'awaiting_comment' && body.message.text) {
        state.comment = body.message.text.trim();

        await axios.post(GAS_WEB_APP_URL, {
          row: state.row,
          message_id: state.messageId,
          photo: state.photoUrl,
          sum: state.sum,
          comment: state.comment,
          username: `@${username}`,
          status: 'Выполнено',
        });

        // Получаем просрочку из таблицы через GAS
        const response = await axios.post(GAS_WEB_APP_URL, {
          row: state.row,
          action: 'get_overdue',
        });

        const overdue = response.data?.overdue || '—';

        await editMessage(chatId, state.messageId, `📌 Заявка #${row} закрыта.\n📎 Фото: ${state.photoUrl}\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: @${username}\n✅ Статус: Выполнено\nПросрочка: ${overdue} дн.`);

        delete userStates[chatId];

        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Бот запущен ✅'));
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
