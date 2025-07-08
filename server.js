require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const uploads = {}; // временное хранилище
const userSteps = {};

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    await handleCallback(body.callback_query);
  } else if (body.message) {
    await handleMessage(body.message);
  }

  res.sendStatus(200);
});

// === Обработка инлайн-кнопок ===
async function handleCallback(callback) {
  const chat_id = callback.message.chat.id;
  const msgId = callback.message.message_id;
  const data = callback.data;
  const username = callback.from.username || 'неизвестно';
  const row = getRowFromText(callback.message.text);

  if (data === 'take') {
    await setExecutorAndShowActions(chat_id, msgId, username, row);
  }

  if (data === 'done') {
    uploads[chat_id] = { step: 'photo', row, username };
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: '📸 Отправьте фото выполненной работы:'
    });
  }

  if (data === 'wait') {
    await updateStatus(row, 'Ожидает поставки', username);
    await sendFinalMessage(chat_id, row, username, 'Ожидает поставки');
  }

  if (data === 'cancel') {
    await updateStatus(row, 'Отменено', username);
    await sendFinalMessage(chat_id, row, username, 'Отменено');
  }

  // Удаление кнопок после ответа
  await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    chat_id,
    message_id: msgId,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});
}

// === Обработка обычных сообщений (фото, сумма, комментарий) ===
async function handleMessage(message) {
  const chat_id = message.chat.id;
  const content = message.text || '';
  const photo = message.photo;

  const userData = uploads[chat_id];
  if (!userData) return;

  if (userData.step === 'photo' && photo) {
    const fileId = photo[photo.length - 1].file_id;
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = fileRes.data.result.file_path;
    const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

    const photoLink = fileUrl;
    uploads[chat_id].photo = photoLink;
    uploads[chat_id].step = 'sum';

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: '💰 Укажите сумму работ:'
    });

  } else if (userData.step === 'sum' && content) {
    uploads[chat_id].sum = content;
    uploads[chat_id].step = 'comment';

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: '✏️ Добавьте комментарий:'
    });

  } else if (userData.step === 'comment' && content) {
    uploads[chat_id].comment = content;
    uploads[chat_id].step = 'done';

    await saveFinalData(chat_id);
  }
}

// === Устанавливаем исполнителя и показываем кнопки действий ===
async function setExecutorAndShowActions(chat_id, msgId, executor, row) {
  await axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id,
    message_id: Number(msgId)
  }).catch(() => {});

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text: `👤 Исполнитель @${executor} назначен. Заявка принята в работу.`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Выполнено', callback_data: 'done' },
          { text: '🕓 Ожидает поставки', callback_data: 'wait' },
          { text: '❌ Отменить', callback_data: 'cancel' }
        ]
      ]
    }
  });

  await axios.post(GAS_WEB_APP_URL, {
    row,
    executor,
    status: 'В работе'
  });
}

// === Сохраняем финальные данные в таблицу ===
async function saveFinalData(chat_id) {
  const { row, username, photo, sum, comment } = uploads[chat_id];

  await axios.post(GAS_WEB_APP_URL, {
    row,
    status: 'Выполнено',
    photo,
    sum,
    comment,
    executor: username
  });

  await sendFinalMessage(chat_id, row, username, 'Выполнено', sum, photo, comment);

  delete uploads[chat_id];
}

// === Отправка финального сообщения ===
async function sendFinalMessage(chat_id, row, username, status, sum = '', photo = '', comment = '') {
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  let text = `📌 Заявка #${row} закрыта.\n`;
  if (photo) text += `📎 Фото: [ссылка](${photo})\n`;
  if (sum) text += `💰 Сумма: ${sum} сум\n`;
  text += `👤 Исполнитель: @${username}\n`;
  text += `✅ Статус: ${status}\n`;
  if (comment) text += `💬 Комментарий: ${comment}`;

  const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    parse_mode: 'Markdown'
  });

  // Удаление финального сообщения через минуту
  await delay(60000);
  await axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id,
    message_id: sent.data.result.message_id
  }).catch(() => {});
}

// === Обновление статуса без финального диалога ===
async function updateStatus(row, status, executor) {
  await axios.post(GAS_WEB_APP_URL, {
    row,
    status,
    executor
  });
}

// === Получение номера строки из текста заявки ===
function getRowFromText(text) {
  const match = text.match(/#(\d+)/);
  return match ? Number(match[1]) : null;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
