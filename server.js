// server.js — Telegram бот с выбором исполнителя, загрузкой фото в Google Диск, записью в таблицу и автоудалением сообщений

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const PORT = process.env.PORT || 3000;

const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
const state = new Map();
const cleanupQueue = new Map();

// Удаление сообщений через минуту
async function deleteMessages(chat_id, messages) {
  for (const msgId of messages) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id,
        message_id: msgId
      });
    } catch (e) {
      console.log('❌ Ошибка удаления сообщения', msgId);
    }
  }
}

// Загрузка на Google Диск
async function uploadToDrive(fileUrl, filename) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_KEY),
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  const drive = google.drive({ version: 'v3', auth });

  const tempPath = path.join('/tmp', filename);
  const writer = fs.createWriteStream(tempPath);
  const fileRes = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
  fileRes.data.pipe(writer);
  await new Promise((resolve) => writer.on('finish', resolve));

  const upload = await drive.files.create({
    requestBody: { name: filename, parents: [FOLDER_ID] },
    media: { mimeType: 'image/jpeg', body: fs.createReadStream(tempPath) }
  });

  await drive.permissions.create({
    fileId: upload.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/file/d/${upload.data.id}/view`;
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const chat_id = body.message?.chat?.id || body.callback_query?.message?.chat?.id;

    if (body.callback_query) {
      const [action, row, msgId, extra] = body.callback_query.data.split(':');
      if (action === 'in_progress') {
        state.set(chat_id, { stage: 'waiting_executor', row, msgId });
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id,
          message_id: msgId,
          reply_markup: { inline_keyboard: [[{ text: '🔄 Выбор исполнителя...', callback_data: 'noop' }]] }
        });
        const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `👤 Кто будет исполнителем заявки №${row}?`,
          reply_markup: {
            inline_keyboard: EXECUTORS.map(e => [{ text: e, callback_data: `executor:${row}:${msgId}:${e}` }])
          }
        });
        cleanupQueue.set(chat_id, [msg.data.result.message_id]);
      }

      if (action === 'executor') {
        const executor = extra;
        const userState = state.get(chat_id);
        userState.username = executor;
        state.set(chat_id, userState);

        await axios.post(GAS_WEB_APP_URL, {
          action: 'inProgress',
          row: userState.row,
          message_id: userState.msgId,
          username: executor
        });

        const conf = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `👤 Заявка №${userState.row} закреплена за ${executor}`
        });

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id,
          message_id: userState.msgId,
          reply_markup: {
            inline_keyboard: [
              [{ text: '🟢 В работе', callback_data: 'noop' }],
              [
                { text: '✅ Выполнено', callback_data: `done:${userState.row}:${userState.msgId}` },
                { text: '🕓 Ожидает поставки', callback_data: `awaiting:${userState.row}:${userState.msgId}` },
                { text: '❌ Отмена', callback_data: `cancel:${userState.row}:${userState.msgId}` }
              ]
            ]
          }
        });
        cleanupQueue.set(chat_id, [...(cleanupQueue.get(chat_id) || []), conf.data.result.message_id]);
      }

      if (action === 'done') {
        const s = state.get(chat_id);
        s.stage = 'waiting_photo';
        state.set(chat_id, s);
        const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: '📷 Пожалуйста, отправьте фото выполненных работ'
        });
        cleanupQueue.set(chat_id, [...(cleanupQueue.get(chat_id) || []), m.data.result.message_id]);
      }

      return res.sendStatus(200);
    }

    const msg = body.message;
    if (!msg || !state.has(chat_id)) return res.sendStatus(200);
    const s = state.get(chat_id);

    if (s.stage === 'waiting_photo' && msg.photo) {
      const file_id = msg.photo.at(-1).file_id;
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
      const tgUrl = `${TELEGRAM_FILE_API}/${fileRes.data.result.file_path}`;
      s.photo = await uploadToDrive(tgUrl, `Заявка_${s.row}.jpg`);
      s.stage = 'waiting_sum';
      state.set(chat_id, s);
      const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '💰 Укажите сумму выполненных работ (в сум)'
      });
      cleanupQueue.set(chat_id, [...(cleanupQueue.get(chat_id) || []), m.data.result.message_id]);
      return res.sendStatus(200);
    }

    if (s.stage === 'waiting_sum' && msg.text) {
      const sum = msg.text.trim().replace(/\s/g, '');
      if (isNaN(sum)) return res.sendStatus(200);
      s.sum = sum;
      s.stage = 'waiting_comment';
      state.set(chat_id, s);
      const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '📝 Добавьте комментарий'
      });
      cleanupQueue.set(chat_id, [...(cleanupQueue.get(chat_id) || []), m.data.result.message_id]);
      return res.sendStatus(200);
    }

    if (s.stage === 'waiting_comment' && msg.text) {
      s.comment = msg.text;
      await axios.post(GAS_WEB_APP_URL, {
        action: 'completed',
        row: s.row,
        message_id: s.msgId,
        photo: s.photo,
        sum: s.sum,
        comment: s.comment,
        username: s.username
      });

      const fin = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `✅ Заявка #${s.row} закрыта.\n💰 Сумма: ${s.sum} сум\n👤 Исполнитель: ${s.username}\n📎 Фото: ${s.photo}`
      });

      const toDelete = [...(cleanupQueue.get(chat_id) || []), msg.message_id, fin.data.result.message_id];
      setTimeout(() => deleteMessages(chat_id, toDelete), 60000);

      state.delete(chat_id);
      cleanupQueue.delete(chat_id);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('❌ Ошибка:', e.message);
    if (e.response) console.error(e.response.data);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
