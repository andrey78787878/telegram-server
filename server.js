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
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GOOGLE_DRIVE_FOLDER_ID = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';

let userStates = {}; // Состояние по пользователям: ожидаем фото, сумму, комментарий
let serviceMessages = {}; // ID сообщений для последующего удаления

// 📥 Получение обновлений от Telegram
app.post('/', async (req, res) => {
  const body = req.body;
  console.log('🔔 Новое обновление:', JSON.stringify(body, null, 2));

  try {
    if (body.callback_query) {
      await handleCallbackQuery(body.callback_query);
    } else if (body.message) {
      await handleUserMessage(body.message);
    }
  } catch (err) {
    console.error('❌ Ошибка обработки:', err.message);
  }

  res.sendStatus(200);
});

// 🔘 Обработка нажатий кнопок
async function handleCallbackQuery(query) {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const username = from.username ? '@' + from.username : from.first_name;

  const [action, row] = data.split(':');

  console.log('📲 Callback:', action, row);

  if (action === 'accept') {
    await axios.post(`${GAS_WEB_APP_URL}?status=Принято в работу&row=${row}&executor=${username}`);
    await editInlineKeyboard(chatId, messageId, '🟢 В работе', row);
    await sendNextButtons(chatId, row);
  }

  if (action === 'cancel') {
    await axios.post(`${GAS_WEB_APP_URL}?status=Отменено&row=${row}&executor=${username}`);
    await editInlineKeyboard(chatId, messageId, '🔴 Отменено', row);
    await sendText(chatId, `❌ Заявка #${row} отменена исполнителем ${username}`);
  }

  if (action === 'wait') {
    await axios.post(`${GAS_WEB_APP_URL}?status=Ожидает поставки&row=${row}&executor=${username}`);
    await editInlineKeyboard(chatId, messageId, '🟡 Ожидает поставки', row);
    await sendText(chatId, `⏳ Заявка #${row} ожидает поставки. Ответственный: ${username}`);
  }

  if (action === 'done') {
    userStates[chatId] = { step: 'photo', row, messageId, username };
    const sent = await sendText(chatId, '📸 Пожалуйста, пришлите фото выполненных работ');
    saveService(chatId, sent.message_id);
  }
}

// 💬 Обработка сообщений от пользователя
async function handleUserMessage(message) {
  const chatId = message.chat.id;
  const state = userStates[chatId];
  if (!state) return;

  if (state.step === 'photo' && message.photo) {
    const fileId = message.photo.at(-1).file_id;
    const fileUrl = await getFileUrl(fileId);
    const filePath = await downloadFile(fileUrl, fileId);
    const photoLink = await uploadToDrive(filePath);
    fs.unlinkSync(filePath);

    state.photoLink = photoLink;
    state.step = 'sum';

    const sent = await sendText(chatId, '💰 Укажите сумму выполненных работ в сумах');
    saveService(chatId, sent.message_id);
    return;
  }

  if (state.step === 'sum' && message.text) {
    state.sum = message.text;
    state.step = 'comment';

    const sent = await sendText(chatId, '💬 Добавьте комментарий по заявке');
    saveService(chatId, sent.message_id);
    return;
  }

  if (state.step === 'comment' && message.text) {
    state.comment = message.text;

    await axios.post(GAS_WEB_APP_URL, {
      photo: state.photoLink,
      sum: state.sum,
      comment: state.comment,
      row: state.row,
      username: state.username,
    });

    const delayMs = 60 * 1000;
    setTimeout(() => cleanupMessages(chatId), delayMs);

    await editMessage(chatId, state.messageId, state);

    await sendText(chatId, `✅ Заявка #${state.row} закрыта. 💰 ${state.sum} сум 👤 ${state.username}`);

    delete userStates[chatId];
    return;
  }

  // Если шаг — фото, но не фото — напомнить
  if (state.step === 'photo' && !message.photo) {
    const sent = await sendText(chatId, '⚠️ Пожалуйста, отправьте фото!');
    saveService(chatId, sent.message_id);
  }
}

// 📌 Обновление исходного сообщения
async function editMessage(chatId, messageId, state) {
  const overdueDays = await fetchOverdue(state.row);

  const text = `📌 Заявка #${state.row} закрыта.
📎 Фото: ${state.photoLink}
💰 Сумма: ${state.sum} сум
👤 Исполнитель: ${state.username}
✅ Статус: Выполнено
Просрочка: ${overdueDays} дн.`;

  await axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  });
}

// 🔄 Получение URL файла
async function getFileUrl(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${res.data.result.file_path}`;
}

// 💾 Скачивание файла
async function downloadFile(url, fileId) {
  const filePath = path.join(__dirname, `${fileId}.jpg`);
  const writer = fs.createWriteStream(filePath);
  const res = await axios.get(url, { responseType: 'stream' });
  res.data.pipe(writer);
  return new Promise((resolve) => writer.on('finish', () => resolve(filePath)));
}

// ☁️ Загрузка на Google Диск
async function uploadToDrive(filePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const file = await drive.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [GOOGLE_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: 'image/jpeg',
      body: fs.createReadStream(filePath),
    },
  });
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

// 📎 Кнопки: в работе
function sendNextButtons(chatId, row) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: `Выберите дальнейшее действие по заявке #${row}:`,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Выполнено', callback_data: `done:${row}` },
        { text: '⏳ Ожидает поставки', callback_data: `wait:${row}` },
        { text: '❌ Отмена', callback_data: `cancel:${row}` },
      ]],
    },
  });
}

// ✏️ Обновление кнопки
function editInlineKeyboard(chatId, messageId, newStatus, row) {
  return axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [[{ text: `${newStatus}`, callback_data: `noop:${row}` }]],
    },
  });
}

// 🧹 Удаление сообщений через минуту
function saveService(chatId, msgId) {
  if (!serviceMessages[chatId]) serviceMessages[chatId] = [];
  serviceMessages[chatId].push(msgId);
}

async function cleanupMessages(chatId) {
  if (!serviceMessages[chatId]) return;
  for (const msgId of serviceMessages[chatId]) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (e) {
      console.warn('Не удалось удалить сообщение', msgId);
    }
  }
  serviceMessages[chatId] = [];
}

// 📤 Отправка сообщения
function sendText(chatId, text) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
  }).then(res => res.data.result);
}

// 🔎 Получение просрочки из таблицы
async function fetchOverdue(row) {
  try {
    const res = await axios.get(`${GAS_WEB_APP_URL}?row=${row}&getOverdue=1`);
    return res.data.overdue || 0;
  } catch {
    return 0;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер Telegram-бота запущен на порту ${PORT}`);
});
