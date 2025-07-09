require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const GOOGLE_FOLDER_ID = process.env.GOOGLE_FOLDER_ID;

const chatStates = new Map(); // Храним состояния пользователей

// Google Auth
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

function sendMessage(chat_id, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    ...options,
  });
}

function editMessage(chat_id, message_id, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id,
    message_id,
    text,
    ...options,
  });
}

function deleteMessage(chat_id, message_id) {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id,
    message_id,
  });
}

// 📥 Получаем ссылку на файл Telegram
async function downloadTelegramFile(fileId, filename) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = res.data.result.file_path;
  const url = `${TELEGRAM_FILE_API}/${filePath}`;

  const response = await axios.get(url, { responseType: 'stream' });
  const filePathLocal = path.join(__dirname, filename);
  const writer = fs.createWriteStream(filePathLocal);

  response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return filePathLocal;
}

// 📤 Загрузка фото на Google Диск
async function uploadToDrive(localPath, fileName) {
  const fileMetadata = { name: fileName, parents: [GOOGLE_FOLDER_ID] };
  const media = { mimeType: 'image/jpeg', body: fs.createReadStream(localPath) };

  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });

  // Открыть доступ
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  fs.unlinkSync(localPath);
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

// 📡 Webhook входящие
app.post('/', async (req, res) => {
  const msg = req.body.message || req.body.callback_query?.message;
  const chatId = msg?.chat.id;
  const messageId = msg?.message_id;
  const username = req.body.message?.from?.username || req.body.callback_query?.from?.username;

  try {
    // === 1. Кнопки
    if (req.body.callback_query) {
      const data = req.body.callback_query.data;
      const originMsgId = msg.message_id;
      const row = req.body.callback_query.message.reply_markup?.inline_keyboard[0]?.[0]?.callback_data?.split('|')[1];
      const executor = `@${username}`;

      if (data.startsWith('accept|')) {
        await editMessage(chatId, originMsgId, `✅ Принято в работу исполнителем: ${executor}`, {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Выполнено', callback_data: `done|${row}` },
              { text: 'Ожидает поставки', callback_data: `wait|${row}` },
              { text: 'Отмена', callback_data: `cancel|${row}` },
            ]],
          },
        });
        await axios.post(GAS_WEB_APP_URL, { message_id: originMsgId, status: 'В работе', executor });
        return res.sendStatus(200);
      }

      if (data.startsWith('done|')) {
        chatStates.set(chatId, { step: 'waiting_photo', message_id: originMsgId, row, username });
        await sendMessage(chatId, '📷 Отправьте фото выполненных работ');
        return res.sendStatus(200);
      }

      if (data.startsWith('cancel|')) {
        await axios.post(GAS_WEB_APP_URL, { message_id: originMsgId, status: 'Отменено' });
        await editMessage(chatId, originMsgId, `❌ Заявка отменена исполнителем: ${executor}`);
        return res.sendStatus(200);
      }

      if (data.startsWith('wait|')) {
        await axios.post(GAS_WEB_APP_URL, { message_id: originMsgId, status: 'Ожидает поставки' });
        await editMessage(chatId, originMsgId, `⏳ Заявка в ожидании поставки. Исполнитель: ${executor}`);
        return res.sendStatus(200);
      }
    }

    // === 2. Получение фото
    const state = chatStates.get(chatId);
    if (state?.step === 'waiting_photo' && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const localPath = await downloadTelegramFile(fileId, `${state.username}_${Date.now()}.jpg`);
      const photoUrl = await uploadToDrive(localPath, path.basename(localPath));

      state.photoUrl = photoUrl;
      state.step = 'waiting_sum';
      chatStates.set(chatId, state);
      await sendMessage(chatId, '💰 Введите сумму выполненных работ:');
      return res.sendStatus(200);
    }

    // === 3. Получение суммы
    if (state?.step === 'waiting_sum' && msg.text) {
      state.sum = msg.text;
      state.step = 'waiting_comment';
      chatStates.set(chatId, state);
      await sendMessage(chatId, '📝 Введите комментарий (или "-" если без комментария):');
      return res.sendStatus(200);
    }

    // === 4. Получение комментария
    if (state?.step === 'waiting_comment' && msg.text) {
      state.comment = msg.text;

      // Отправка данных в GAS
      await axios.post(GAS_WEB_APP_URL, {
        photo: state.photoUrl,
        sum: state.sum,
        comment: state.comment,
        username: state.username,
        message_id: state.message_id,
        row: state.row,
        executor: `@${state.username}`,
      });

      // Финальное сообщение
      await editMessage(chatId, state.message_id, `📌 Заявка #${state.row} закрыта.
📎 Фото: [ссылка](${state.photoUrl})
💰 Сумма: ${state.sum} сум
👤 Исполнитель: @${state.username}
✅ Статус: Выполнено`);

      await sendMessage(chatId, '✅ Спасибо, заявка закрыта.');

      // Очистка состояния
      chatStates.delete(chatId);
      return res.sendStatus(200);
    }
  } catch (error) {
    console.error('Ошибка в обработке:', error.message);
  }

  res.sendStatus(200);
});

// ✅ Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
