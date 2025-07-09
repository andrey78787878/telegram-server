require('dotenv').config();
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
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];

const userState = new Map();

// Google Drive setup
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'certs', 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

// === Удаление сообщений через 60 сек
const deleteAfter = async (chat_id, message_id, delay = 60000) => {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id,
      message_id
    }).catch(() => {});
  }, delay);
};

// === Загрузка фото из Telegram и загрузка на Google Диск
async function uploadPhotoToDrive(fileId, filename) {
  const filePathRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = filePathRes.data.result.file_path;
  const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
  const response = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [GOOGLE_DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: 'image/jpeg',
      body: response.data
    }
  });

  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/file/d/${res.data.id}/view?usp=sharing`;
}

// === Обработка inline-кнопок
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { id, from, data, message } = body.callback_query;
    const chat_id = message.chat.id;
    const message_id = message.message_id;
    const username = from.username ? '@' + from.username : from.first_name;
    const row = message.text.match(/Заявка №(\d+)/)?.[1];

    if (data === 'accept') {
      const buttons = EXECUTORS.map(name => [{ text: name, callback_data: `exec_${name}` }]);
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '👤 Выберите исполнителя:',
        reply_markup: { inline_keyboard: buttons }
      });
    }

    if (data.startsWith('exec_')) {
      const executor = data.split('exec_')[1];
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `👤 Заявка №${row} закреплена за ${executor}`
      });

      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id,
        message_id,
        reply_markup: {
          inline_keyboard: [[
            { text: 'В работе 🟢', callback_data: 'in_progress' }
          ]]
        }
      });

      await axios.post(GAS_WEB_APP_URL, {
        row,
        message_id,
        status: 'В работе',
        executor
      });
    }

    if (data === 'in_progress') {
      const buttons = [
        [{ text: '✅ Выполнено', callback_data: 'done' }],
        [{ text: '⏳ Ожидает поставки', callback_data: 'pending' }],
        [{ text: '❌ Отмена', callback_data: 'cancel' }]
      ];
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `⏱ Выберите действие по заявке №${row}:`,
        reply_markup: { inline_keyboard: buttons }
      });
    }

    if (data === 'done') {
      userState.set(chat_id, { step: 'photo', row, username, message_id });
      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '📷 Отправьте фото выполненных работ'
      });
      deleteAfter(chat_id, msg.data.result.message_id);
    }

    res.sendStatus(200);
    return;
  }

  if (body.message && userState.has(body.message.chat.id)) {
    const chat_id = body.message.chat.id;
    const state = userState.get(chat_id);
    const msgId = body.message.message_id;

    if (state.step === 'photo' && body.message.photo) {
      const fileId = body.message.photo.at(-1).file_id;
      const photoUrl = await uploadPhotoToDrive(fileId, `photo_${state.row}.jpg`);
      state.photo = photoUrl;
      state.step = 'sum';
      userState.set(chat_id, state);
      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '💰 Введите сумму выполненных работ'
      });
      deleteAfter(chat_id, msg.data.result.message_id);
    }

    else if (state.step === 'sum' && body.message.text) {
      state.sum = body.message.text;
      state.step = 'comment';
      userState.set(chat_id, state);
      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '💬 Введите комментарий'
      });
      deleteAfter(chat_id, msg.data.result.message_id);
    }

    else if (state.step === 'comment' && body.message.text) {
      state.comment = body.message.text;
      userState.delete(chat_id);

      await axios.post(GAS_WEB_APP_URL, {
        row: state.row,
        message_id: state.message_id,
        photo: state.photo,
        sum: state.sum,
        comment: state.comment,
        username: state.username,
        executor: state.username
      });

      const finalMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `✅ Заявка №${state.row} закрыта.\n📎 Фото: [ссылка](${state.photo})\n💰 Сумма: ${state.sum}\n👤 Исполнитель: ${state.username}`,
        parse_mode: 'Markdown'
      });

      deleteAfter(chat_id, finalMsg.data.result.message_id);
    }

    deleteAfter(chat_id, msgId);
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Telegram bot server running');
});
