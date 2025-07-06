const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbx-yVE9Z8lWDVNUoLrGbuEfp7hyvHogQfPLc9ehH6afPmAEIlqLSj6r3RuzTK9NmA4W/exec';

const folderId = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: SCOPES,
});
const drive = google.drive({ version: 'v3', auth });

let userState = {}; // Для отслеживания этапов: фото → сумма → комментарий

// === Вспомогательные кнопки ===
function getInitialButtons(messageId) {
  return {
    inline_keyboard: [[
      { text: 'Принято в работу', callback_data: JSON.stringify({ action: 'in_progress', messageId }) },
    ]],
  };
}

function getWorkButtons(messageId) {
  return {
    inline_keyboard: [[
      { text: 'Выполнено ✅', callback_data: JSON.stringify({ action: 'completed', messageId }) },
      { text: 'Ожидает поставки ⏳', callback_data: JSON.stringify({ action: 'delayed', messageId }) },
      { text: 'Отмена ❌', callback_data: JSON.stringify({ action: 'cancelled', messageId }) },
    ]],
  };
}

// === Google Drive Upload ===
async function uploadPhotoToDrive(fileBuffer, filename) {
  const fileMetadata = { name: filename, parents: [folderId] };
  const media = { mimeType: 'image/jpeg', body: fileBuffer };
  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });
  const fileId = file.data.id;
  await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
  return `https://drive.google.com/uc?id=${fileId}`;
}

// === Удаление сообщений ===
async function deleteMessages(chatId, messageIds) {
  for (const msgId of messageIds) {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: msgId,
    }).catch(() => {});
  }
}

// === Обработка кнопок ===
app.post('/', async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { message, data, from } = body.callback_query;
    const { action, messageId } = JSON.parse(data);
    const chatId = message.chat.id;
    const username = from.username || 'неизвестен';

    // Удаление сообщения выбора
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: message.message_id,
    });

    if (action === 'in_progress') {
      await axios.post(GAS_ENDPOINT, {
        message_id: messageId,
        status: 'В работе',
        executor: `@${username}`,
      });

      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: JSON.stringify(getWorkButtons(messageId)),
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `👤 Заявка #${messageId} принята в работу исполнителем: @${username}`,
        reply_to_message_id: messageId,
      });
    }

    if (action === 'completed') {
      userState[chatId] = { stage: 'awaiting_photo', messageId, username, tempMsgs: [] };
      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '📸 Пожалуйста, отправьте фото выполненной работы.',
      });
      userState[chatId].tempMsgs.push(msg.data.result.message_id);
    }

    if (action === 'delayed' || action === 'cancelled') {
      const status = action === 'delayed' ? 'Ожидает поставки' : 'Отменено';
      await axios.post(GAS_ENDPOINT, {
        message_id: messageId,
        status,
      });
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `🔄 Заявка #${messageId}: ${status}`,
        reply_to_message_id: messageId,
      });
    }

    return res.sendStatus(200);
  }

  if (body.message && userState[body.message.chat.id]) {
    const state = userState[body.message.chat.id];
    const chatId = body.message.chat.id;
    const messageId = state.messageId;
    const username = state.username;
    const replyMsgs = state.tempMsgs || [];

    // === Этап 1: Фото ===
    if (state.stage === 'awaiting_photo' && body.message.photo) {
      const fileId = body.message.photo.slice(-1)[0].file_id;
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      const fileBuffer = (await axios.get(fileUrl, { responseType: 'stream' })).data;

      const driveLink = await uploadPhotoToDrive(fileBuffer, `done_${messageId}.jpg`);
      state.photo = driveLink;
      state.stage = 'awaiting_sum';
      replyMsgs.push(body.message.message_id);

      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '💰 Укажите сумму, затраченную на выполнение заявки (в сумах):',
      });
      replyMsgs.push(msg.data.result.message_id);

      state.tempMsgs = replyMsgs;
      return res.sendStatus(200);
    }

    // === Этап 2: Сумма ===
    if (state.stage === 'awaiting_sum' && body.message.text) {
      const sum = body.message.text.replace(/[^\d]/g, '');
      state.sum = sum;
      state.stage = 'awaiting_comment';
      replyMsgs.push(body.message.message_id);

      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '📝 Добавьте комментарий к выполненной заявке:',
      });
      replyMsgs.push(msg.data.result.message_id);

      state.tempMsgs = replyMsgs;
      return res.sendStatus(200);
    }

    // === Этап 3: Комментарий ===
    if (state.stage === 'awaiting_comment' && body.message.text) {
      const comment = body.message.text;
      replyMsgs.push(body.message.message_id);

      await axios.post(GAS_ENDPOINT, {
        message_id: messageId,
        photo: state.photo,
        sum: state.sum,
        comment,
        executor: `@${username}`,
      });

      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text: `📌 Заявка #${messageId} закрыта.\n📎 Фото: ${state.photo}\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: @${username}\n✅ Статус: Выполнено`,
        parse_mode: 'HTML',
      });

      setTimeout(() => deleteMessages(chatId, replyMsgs), 60000);
      delete userState[chatId];
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log('Server running on port 3000'));
