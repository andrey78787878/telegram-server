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
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const userStates = new Map();
const messageToDelete = [];

const auth = new google.auth.GoogleAuth({
  credentials: require('./credentials.json'),
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

function sendMessage(chatId, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

function editMessage(chatId, messageId, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

function deleteMessage(chatId, messageId) {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId,
  }).catch(() => {});
}

async function uploadPhotoToDrive(filePath, fileName) {
  const fileMetadata = {
    name: fileName,
    parents: [DRIVE_FOLDER_ID],
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath),
  };
  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });
  return file.data.id;
}

async function getFilePath(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${res.data.result.file_path}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchLinkFromColumnS(row) {
  const res = await axios.post(GAS_WEB_APP_URL, {
    action: 'getPhotoLinkFromColumnS',
    row,
  });
  return res.data?.photoUrl;
}

app.post('/webhook', async (req, res) => {
  const body = req.body;
  res.sendStatus(200);

  if (body.callback_query) {
    const { data, message, from } = body.callback_query;
    const [action, row, messageId] = data.split(':');

    const chatId = message.chat.id;
    const userId = from.username || from.id;
    const replyMarkup = { inline_keyboard: [] };

    if (action === 'accept') {
      await axios.post(GAS_WEB_APP_URL, {
        action: 'accepted',
        row,
        executor: userId,
      });

      await editMessage(chatId, message.message_id, `✅ Заявка #${row} принята @${userId}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}:${messageId}` },
              { text: '🕒 Ожидает поставки', callback_data: `wait:${row}:${messageId}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}:${messageId}` },
            ],
          ],
        },
      });
    }

    if (action === 'done') {
      userStates.set(chatId, { step: 'awaiting_photo', row, messageId, executor: userId });

      const msg = await sendMessage(chatId, '📷 Пришлите фото выполненной работы');
      messageToDelete.push({ chatId, messageId: msg.data.message_id });
    }

    if (action === 'wait' || action === 'cancel') {
      await axios.post(GAS_WEB_APP_URL, {
        action,
        row,
        executor: userId,
      });
      await editMessage(chatId, message.message_id, `⏳ Заявка #${row}: ${action === 'wait' ? 'Ожидает поставки' : 'Отменена'} от @${userId}`);
    }
  }

  if (body.message && body.message.photo) {
    const { chat, photo, message_id } = body.message;
    const chatId = chat.id;
    const state = userStates.get(chatId);

    if (state?.step === 'awaiting_photo') {
      const fileId = photo[photo.length - 1].file_id;
      const fileUrl = await getFilePath(fileId);
      const fileName = `photo_${state.row}_${Date.now()}.jpg`;

      const photoRes = await axios.get(fileUrl, { responseType: 'stream' });
      const filePath = path.join(__dirname, fileName);
      const writer = fs.createWriteStream(filePath);
      photoRes.data.pipe(writer);

      await new Promise((resolve) => writer.on('finish', resolve));
      const fileDriveId = await uploadPhotoToDrive(filePath, fileName);
      fs.unlinkSync(filePath);

      await axios.post(GAS_WEB_APP_URL, {
        action: 'savePhoto',
        row: state.row,
        fileId: fileDriveId,
      });

      userStates.set(chatId, { ...state, step: 'awaiting_sum' });
      const msg = await sendMessage(chatId, '💰 Введите сумму:');
      messageToDelete.push({ chatId, messageId: body.message.message_id }, { chatId, messageId: msg.data.message_id });
    }
  }

  if (body.message && body.message.text) {
    const { chat, text, message_id } = body.message;
    const chatId = chat.id;
    const state = userStates.get(chatId);

    if (state?.step === 'awaiting_sum') {
      userStates.set(chatId, { ...state, sum: text, step: 'awaiting_comment' });
      const msg = await sendMessage(chatId, '📝 Введите комментарий:');
      messageToDelete.push({ chatId, messageId });
    } else if (state?.step === 'awaiting_comment') {
      userStates.delete(chatId);

      await axios.post(GAS_WEB_APP_URL, {
        action: 'saveDone',
        row: state.row,
        sum: state.sum,
        comment: text,
        executor: state.executor,
      });

      const finalMsg = await sendMessage(chatId, `✅ Заявка #${state.row} закрыта.\n💰 Сумма: ${state.sum}\n👤 Исполнитель: @${state.executor}`);

      // ⏱ Через 2 минуты: подменить ссылку на S, удалить все сообщения
      setTimeout(async () => {
        try {
          const newLink = await fetchLinkFromColumnS(state.row);
          if (newLink) {
            const oldText = `📎 Фото:`;
            const newText = `📎 Фото: <a href="${newLink}">Ссылка</a>`;

            await axios.post(`${TELEGRAM_API}/editMessageText`, {
              chat_id: chatId,
              message_id: Number(state.messageId),
              parse_mode: 'HTML',
              text: `${oldText}\n${newText}`,
            });
          }

          for (const msg of messageToDelete.filter(m => m.chatId === chatId)) {
            await deleteMessage(msg.chatId, msg.messageId);
          }

          await deleteMessage(chatId, finalMsg.data.message_id);
        } catch (e) {
          console.error('Ошибка при подмене ссылки или удалении:', e.message);
        }
      }, 120_000);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
