require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 3000;

// Очистка и хранение сообщений
const userStates = new Map();

// 💬 Удаление сообщений через минуту
async function deleteAfterDelay(chatId, messageId) {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    }).catch(console.error);
  }, 60000);
}

// 📸 Загрузка фото в Google Drive
async function uploadToDrive(filePath, fileName) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(fs.readFileSync('credentials.json')),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const fileMetadata = {
    name: fileName,
    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath),
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  const fileId = response.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return `https://drive.google.com/uc?id=${fileId}`;
}

// 🌐 Обработка входящих Webhook
app.post('/', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  // ⏩ Обработка inline-кнопок
  if (body.callback_query) {
    const callback = body.callback_query;
    const [action, msgId, row] = callback.data.split(':');
    const chatId = callback.message.chat.id;
    const username = callback.from.username || 'без имени';

    console.log(`➡️ Callback: ${callback.data}`);

    if (action === 'done') {
      userStates.set(chatId, { step: 'awaiting_photo', row, msgId, username });
      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '📷 Отправьте фото выполненных работ',
      });
      deleteAfterDelay(chatId, sent.data.result.message_id);
    }
    return;
  }

  // 📥 Фото, сумма, комментарий
  if (body.message && body.message.photo) {
    const chatId = body.message.chat.id;
    const userState = userStates.get(chatId);
    if (!userState || userState.step !== 'awaiting_photo') return;

    const fileId = body.message.photo.slice(-1)[0].file_id;
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = fileRes.data.result.file_path;

    const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
    const fileLocalPath = path.join(__dirname, 'photo.jpg');
    const writer = fs.createWriteStream(fileLocalPath);
    const imageStream = await axios.get(fileUrl, { responseType: 'stream' });
    imageStream.data.pipe(writer);

    writer.on('finish', async () => {
      const photoUrl = await uploadToDrive(fileLocalPath, `photo_${Date.now()}.jpg`);
      fs.unlinkSync(fileLocalPath);

      userState.photo = photoUrl;
      userState.step = 'awaiting_sum';

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '💰 Укажите сумму работ (только число):',
      });
      deleteAfterDelay(chatId, sent.data.result.message_id);
    });
    return;
  }

  if (body.message && body.message.text && userStates.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const text = body.message.text;
    const state = userStates.get(chatId);

    if (state.step === 'awaiting_sum') {
      state.sum = text;
      state.step = 'awaiting_comment';
      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '📝 Напишите комментарий по заявке:',
      });
      deleteAfterDelay(chatId, sent.data.result.message_id);
      return;
    }

    if (state.step === 'awaiting_comment') {
      state.comment = text;
      state.step = 'finalizing';

      // Отправка на Google Apps Script
      await axios.post(GAS_WEB_APP_URL, {
        photo: state.photo,
        sum: state.sum,
        comment: state.comment,
        username: state.username,
        message_id: state.msgId,
      });

      // Отправка финального сообщения
      const final = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text:
          `📌 Заявка #${state.row} закрыта\n` +
          `📎 Фото: [Смотреть](${state.photo})\n` +
          `💰 Сумма: ${state.sum} сум\n` +
          `👤 Исполнитель: @${state.username}\n` +
          `📝 Комментарий: ${state.comment}\n` +
          `✅ Статус: Выполнено`,
        parse_mode: 'Markdown',
      });

      deleteAfterDelay(chatId, final.data.result.message_id);
      userStates.delete(chatId);
    }
  }
});

// 🔥 Запуск сервера
app.listen(PORT, () => {
  console.log(`✅ Сервер Telegram бота запущен на порту ${PORT}`);
});
