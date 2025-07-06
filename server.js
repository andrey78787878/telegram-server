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
const GAS_URL = 'https://script.google.com/macros/s/AKfycbx-yVE9Z8lWDVNUoLrGbuEfp7hyvHogQfPLc9ehH6afPmAEIlqLSj6r3RuzTK9NmA4W/exec';

const folderId = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ keyFile: 'service_account.json', scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

const EXECUTORS = [
  { text: '@EvelinaB87', value: '@EvelinaB87' },
  { text: '@Olim19', value: '@Olim19' },
  { text: '@Oblayor_04_09', value: '@Oblayor_04_09' },
  { text: 'Текстовой подрядчик', value: 'Текстовой подрядчик' }
];

const userState = {};

// ========== Утилиты ==========
async function sendMessage(chatId, text, replyMarkup, replyToMessageId) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

  return axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}

function buildInitialButtons(messageId) {
  return {
    inline_keyboard: [[{ text: 'Принято в работу', callback_data: `start_work_${messageId}` }]]
  };
}

function buildFollowUpButtons(messageId) {
  return {
    inline_keyboard: [
      [{ text: '✅ Выполнено', callback_data: JSON.stringify({ action: 'completed', messageId }) }],
      [{ text: '🕐 Ожидает поставки', callback_data: JSON.stringify({ action: 'delayed', messageId }) }],
      [{ text: '❌ Отмена', callback_data: JSON.stringify({ action: 'cancelled', messageId }) }]
    ]
  };
}

async function uploadPhotoToDrive(fileStream, filename) {
  const fileMetadata = { name: filename, parents: [folderId] };
  const media = { mimeType: 'image/jpeg', body: fileStream };

  const file = await drive.files.create({ resource: fileMetadata, media, fields: 'id' });
  const fileId = file.data.id;

  await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
  return `https://drive.google.com/uc?id=${fileId}`;
}

async function deleteMessages(chatId, messageIds) {
  for (const id of messageIds) {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: id }).catch(() => {});
  }
}

// ========== Webhook ==========
app.post('/', async (req, res) => {
  const body = req.body;

  try {
    // === Нажатие кнопки ===
    if (body.callback_query) {
      const cb = body.callback_query;
      const data = cb.data;
      const chatId = cb.message.chat.id;
      const username = cb.from.username || 'неизвестен';
      const messageId = cb.message.message_id;

      // Новый формат (JSON)
      if (typeof data === 'string' && data.startsWith('{')) {
        const parsed = JSON.parse(data);
        const action = parsed.action;
        const msgId = parsed.messageId;

        if (action === 'in_progress') {
          await axios.post(GAS_URL, {
            message_id: msgId,
            status: 'В работе',
            executor: `@${username}`,
          });

          await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
            chat_id: chatId,
            message_id: msgId,
            reply_markup: JSON.stringify(buildFollowUpButtons(msgId)),
          });

          await sendMessage(chatId, `👤 Заявка #${msgId} принята в работу исполнителем: @${username}`, null, msgId);
        }

        if (action === 'completed') {
          userState[chatId] = { stage: 'awaiting_photo', messageId: msgId, username, tempMsgs: [] };
          const msg = await sendMessage(chatId, '📸 Пришлите фото выполненной работы.');
          userState[chatId].tempMsgs.push(msg.data.result.message_id);
        }

        if (action === 'delayed' || action === 'cancelled') {
          const status = action === 'delayed' ? 'Ожидает поставки' : 'Отменено';
          await axios.post(GAS_URL, { message_id: msgId, status });
          await sendMessage(chatId, `🔄 Заявка #${msgId}: ${status}`, null, msgId);
        }

        return res.sendStatus(200);
      }

      // Старый формат: выбор исполнителя
      if (data.startsWith('start_work_')) {
        const row = data.split('_')[2];
        const buttons = EXECUTORS.map(exec => [{ text: exec.text, callback_data: `executor_${exec.value}_${row}_${messageId}` }]);
        const msg = await sendMessage(chatId, 'Выберите исполнителя:', { inline_keyboard: buttons });
        setTimeout(() => deleteMessages(chatId, [msg.data.result.message_id]), 60000);
        return res.sendStatus(200);
      }

      if (data.startsWith('executor_')) {
        const [_, executor, row, parentMsgId] = data.split('_');

        await axios.post(GAS_URL, {
          row,
          executor,
          message_id: parentMsgId,
          status: 'В работе'
        });

        await deleteMessages(chatId, [cb.message.message_id]);

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: Number(parentMsgId),
          text: `🟢 <b>Заявка в работе</b>\n👤 Исполнитель: ${executor}`,
          parse_mode: 'HTML',
          reply_markup: JSON.stringify(buildFollowUpButtons(parentMsgId)),
        });

        return res.sendStatus(200);
      }
    }

    // === Этапы "выполнено" ===
    const message = body.message;
    if (message && userState[message.chat.id]) {
      const state = userState[message.chat.id];
      const chatId = message.chat.id;
      const msgId = state.messageId;
      const replyMsgs = state.tempMsgs || [];

      if (state.stage === 'awaiting_photo' && message.photo) {
        const fileId = message.photo.slice(-1)[0].file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const fileUrl = `${TELEGRAM_FILE_API}/${fileRes.data.result.file_path}`;
        const fileStream = (await axios.get(fileUrl, { responseType: 'stream' })).data;

        const driveLink = await uploadPhotoToDrive(fileStream, `done_${msgId}.jpg`);
        state.photo = driveLink;
        state.stage = 'awaiting_sum';

        replyMsgs.push(message.message_id);
        const msg = await sendMessage(chatId, '💰 Укажите сумму (в сумах):');
        replyMsgs.push(msg.data.result.message_id);
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_sum' && message.text) {
        state.sum = message.text.replace(/[^\d]/g, '');
        state.stage = 'awaiting_comment';
        replyMsgs.push(message.message_id);
        const msg = await sendMessage(chatId, '📝 Добавьте комментарий:');
        replyMsgs.push(msg.data.result.message_id);
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_comment' && message.text) {
        const comment = message.text;
        replyMsgs.push(message.message_id);

        await axios.post(GAS_URL, {
          message_id: msgId,
          photo: state.photo,
          sum: state.sum,
          comment,
          executor: `@${state.username}`,
        });

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: msgId,
          text: `📌 Заявка #${msgId} закрыта.\n📎 Фото: ${state.photo}\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: @${state.username}\n✅ Статус: Выполнено`,
          parse_mode: 'HTML',
        });

        setTimeout(() => deleteMessages(chatId, replyMsgs), 60000);
        delete userState[chatId];
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка в webhook:', err.message, err.stack);
    res.sendStatus(500);
  }
});

// ========== Запуск ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
