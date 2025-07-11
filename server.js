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
const GOOGLE_FOLDER_ID = process.env.GOOGLE_FOLDER_ID;
const PORT = process.env.PORT || 3000;

const stages = {};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendTelegram(method, data) {
  return axios.post(`${TELEGRAM_API}/${method}`, data);
}

async function editMessage(chat_id, message_id, newText, reply_markup = null) {
  return sendTelegram('editMessageText', {
    chat_id,
    message_id,
    text: newText,
    parse_mode: 'HTML',
    reply_markup,
  });
}

async function deleteMessage(chat_id, message_id) {
  return sendTelegram('deleteMessage', { chat_id, message_id });
}

async function downloadFile(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = res.data.result.file_path;
  const url = `${TELEGRAM_FILE_API}/${filePath}`;
  const fileExt = path.extname(filePath);
  const localPath = path.join(__dirname, `photo_${Date.now()}${fileExt}`);

  const response = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(localPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(localPath));
    writer.on('error', reject);
  });
}

async function uploadToDrive(filePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });
  const fileMeta = { name: path.basename(filePath), parents: [GOOGLE_FOLDER_ID] };
  const media = { mimeType: 'image/jpeg', body: fs.createReadStream(filePath) };

  const file = await drive.files.create({
    resource: fileMeta,
    media,
    fields: 'id',
  });

  const fileId = file.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  fs.unlinkSync(filePath);
  return `https://drive.google.com/uc?id=${fileId}`;
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.message) {
      const msg = body.message;
      const chat_id = msg.chat.id;
      const user_id = msg.from.id;

      if (!stages[user_id]) return res.sendStatus(200);

      const stageData = stages[user_id];

      if (msg.photo && stageData.stage === 'awaiting_photo') {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const filePath = await downloadFile(fileId);
        const driveUrl = await uploadToDrive(filePath);
        stageData.photo = driveUrl;

        const sent = await sendTelegram('sendMessage', {
          chat_id,
          text: '💰 Введите сумму:',
        });

        stageData.stage = 'awaiting_sum';
        stageData.messages.push(sent.data.result.message_id);
        return res.sendStatus(200);
      }

      if (msg.text && stageData.stage === 'awaiting_sum') {
        stageData.sum = msg.text;

        const sent = await sendTelegram('sendMessage', {
          chat_id,
          text: '📝 Введите комментарий:',
        });

        stageData.stage = 'awaiting_comment';
        stageData.messages.push(sent.data.result.message_id);
        return res.sendStatus(200);
      }

      if (msg.text && stageData.stage === 'awaiting_comment') {
        stageData.comment = msg.text;
        const { row, message_id, executor, photo, sum, comment } = stageData;

        await axios.post(GAS_WEB_APP_URL, {
          action: 'updateAfterDone',
          row,
          photo,
          sum,
          comment,
          username: msg.from.username,
          executor,
          message_id,
        });

        const finalText = `📌 Заявка #${row} закрыта.\n📎 Фото: ${photo}\n💰 Сумма: ${sum}\n👤 Исполнитель: @${msg.from.username}\n✅ Статус: Выполнено`;

        await editMessage(chat_id, message_id, finalText);
        for (const id of stageData.messages) {
          await deleteMessage(chat_id, id).catch(() => {});
        }

        delete stages[user_id];

        // Через 2 минуты подменить фото в сообщении на публичное из колонки S
        setTimeout(async () => {
          try {
            const gasRes = await axios.post(GAS_WEB_APP_URL, {
              action: 'getPhotoLinkFromColumnS',
              row,
            });
            const newPhoto = gasRes.data?.photo;
            if (newPhoto) {
              const updated = finalText.replace(/📎 Фото: .*/, `📎 Фото: ${newPhoto}`);
              await editMessage(chat_id, message_id, updated);
            }
          } catch (e) {
            console.error('❌ Ошибка обновления фото:', e.message);
          }
        }, 2 * 60 * 1000);
      }

      return res.sendStatus(200);
    }

    if (body.callback_query) {
      const { data, message, from } = body.callback_query;
      const chat_id = message.chat.id;
      const message_id = message.message_id;
      const row = parseInt(data.split(':')[1]);
      const action = data.split(':')[0];

      if (action === 'accept') {
        const executor = from.username || `${from.first_name} ${from.last_name || ''}`;
        await axios.post(GAS_WEB_APP_URL, {
          action: 'accept',
          row,
          username: executor,
          message_id,
        });

        const updated = `${message.text}\n\nВ работе 🟢\n👤 @${executor}`;
        await editMessage(chat_id, message_id, updated, {
          inline_keyboard: [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '📦 Ожидает поставки', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` },
            ],
          ],
        });
      }

      if (action === 'done') {
        const msg1 = await sendTelegram('sendMessage', {
          chat_id,
          text: '📷 Пришлите фото выполненных работ',
        });

        stages[from.id] = {
          stage: 'awaiting_photo',
          row,
          message_id,
          executor: from.username || `${from.first_name} ${from.last_name || ''}`,
          messages: [msg1.data.result.message_id],
        };
      }

      if (action === 'wait' || action === 'cancel') {
        await axios.post(GAS_WEB_APP_URL, {
          action,
          row,
          username: from.username || '',
          message_id,
        });

        const newStatus = action === 'wait' ? '⏳ Ожидает поставки' : '❌ Отменено';
        const updated = `${message.text}\n\nСтатус: ${newStatus}`;
        await editMessage(chat_id, message_id, updated);
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Ошибка обработки webhook:', e.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
