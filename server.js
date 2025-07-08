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
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
const DRIVE_FOLDER_ID = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';

let state = {};

async function getFileLink(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${res.data.result.file_path}`;
}

async function downloadFile(fileUrl, filename) {
  const filePath = path.join(__dirname, 'downloads', filename);
  const writer = fs.createWriteStream(filePath);
  const res = await axios.get(fileUrl, { responseType: 'stream' });
  res.data.pipe(writer);
  return new Promise((resolve) => writer.on('finish', () => resolve(filePath)));
}

async function uploadToDrive(filename) {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });
  const drive = google.drive({ version: 'v3', auth: await auth.getClient() });
  const fileMetadata = { name: filename, parents: [DRIVE_FOLDER_ID] };
  const media = { mimeType: 'image/jpeg', body: fs.createReadStream(path.join(__dirname, 'downloads', filename)) };
  const res = await drive.files.create({ resource: fileMetadata, media, fields: 'id' });
  await drive.permissions.create({ fileId: res.data.id, requestBody: { role: 'reader', type: 'anyone' } });
  return `https://drive.google.com/uc?id=${res.data.id}`;
}

app.post(['/','/webhook'], async (req, res) => {
  const body = req.body;
  console.log('📩 Получен апдейт:', JSON.stringify(body, null, 2));

  if (body.callback_query) {
    const cbq = body.callback_query;
    const { id: callback_id, message, data, from } = cbq;

    if (data.startsWith('in_progress')) {
      const [_, row, msgId] = data.split(':');
      const buttons = EXECUTORS.map((e) => [{ text: e, callback_data: `executor:${row}:${msgId}:${e}` }]);
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: message.chat.id,
        text: 'Выберите исполнителя:',
        reply_markup: { inline_keyboard: buttons }
      });
    }

    if (data.startsWith('executor')) {
      const [_, row, msgId, executor] = data.split(':');
      const origText = message.text;
      const updatedText = `${origText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: message.chat.id,
        message_id: Number(msgId),
        text: updatedText,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Выполнено', callback_data: `done:${row}:${msgId}:${executor}` },
            { text: '🚚 Ожидает поставки', callback_data: `pending:${row}:${msgId}:${executor}` },
            { text: '❌ Отмена', callback_data: `cancel:${row}:${msgId}:${executor}` }
          ]]
        }
      });
      await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: message.chat.id, message_id: message.message_id });
      await axios.post(`${GAS_WEB_APP_URL}`, {
        row, executor, status: 'В работе', action: 'in_progress'
      });
    }

    if (data.startsWith('done')) {
      const [_, row, msgId, executor] = data.split(':');
      state[from.id] = { step: 'awaiting_photo', row, msgId, executor, messagesToDelete: [] };
      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: message.chat.id,
        text: '📸 Пришлите фото выполненных работ'
      });
      state[from.id].messagesToDelete.push(sent.data.result.message_id);
    }

    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback_id });
    return res.sendStatus(200);
  }

  if (body.message && state[body.message.from.id]) {
    const userId = body.message.from.id;
    const userState = state[userId];
    const msg = body.message;

    if (userState.step === 'awaiting_photo' && msg.photo) {
      const fileId = msg.photo.at(-1).file_id;
      const fileUrl = await getFileLink(fileId);
      const filename = `${Date.now()}.jpg`;
      const localPath = await downloadFile(fileUrl, filename);
      const driveUrl = await uploadToDrive(filename);

      userState.photoUrl = driveUrl;
      userState.step = 'awaiting_sum';
      const sumMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: msg.chat.id,
        text: '💰 Введите сумму:'
      });
      userState.messagesToDelete.push(msg.message_id, sumMsg.data.result.message_id);
    } else if (userState.step === 'awaiting_sum' && msg.text) {
      userState.sum = msg.text;
      userState.step = 'awaiting_comment';
      const comMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: msg.chat.id,
        text: '📝 Напишите комментарий:'
      });
      userState.messagesToDelete.push(msg.message_id, comMsg.data.result.message_id);
    } else if (userState.step === 'awaiting_comment' && msg.text) {
      userState.comment = msg.text;

      const response = await axios.get(`${GAS_WEB_APP_URL}?action=getRowData&row=${userState.row}`);
      const rowData = response.data || {};
      const overdues = rowData.overdue || '0';

      await axios.post(`${GAS_WEB_APP_URL}`, {
        action: 'done',
        row: userState.row,
        sum: userState.sum,
        comment: userState.comment,
        photo: userState.photoUrl,
        executor: userState.executor
      });

      const finalText = `📌 Заявка №${userState.row} закрыта.\n📎 Фото: ${userState.photoUrl}\n💰 Сумма: ${userState.sum} сум\n👤 Исполнитель: ${userState.executor}\n✅ Статус: Выполнено\nПросрочка: ${overdues} дн.`;
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: msg.chat.id,
        message_id: Number(userState.msgId),
        text: finalText
      });

      for (const mId of userState.messagesToDelete) {
        setTimeout(() => {
          axios.post(`${TELEGRAM_API}/deleteMessage`, {
            chat_id: msg.chat.id,
            message_id: mId
          });
        }, 60000);
      }

      delete state[userId];
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Server running on port ${PORT}`));
