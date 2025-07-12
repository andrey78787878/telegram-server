require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

const userState = {};
const messageMap = {};

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

async function downloadFile(fileId) {
  const fileUrlResp = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileUrlResp.data.result.file_path;
  const downloadUrl = `${TELEGRAM_FILE_API}/${filePath}`;
  const response = await axios.get(downloadUrl, { responseType: 'stream' });

  const tempPath = path.join(__dirname, 'temp', `${fileId}.jpg`);
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return tempPath;
}

async function uploadToDrive(filePath) {
  const fileName = path.basename(filePath);
  const fileMetadata = {
    name: fileName,
    parents: [GOOGLE_DRIVE_FOLDER_ID],
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath),
  };

  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  fs.unlinkSync(filePath);
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

async function sendTelegramMessage(chat_id, text, options = {}) {
  const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    parse_mode: 'HTML',
    ...options,
  });
  return res.data.result.message_id;
}

async function deleteMessage(chat_id, message_id, delay = 60000) {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id,
      message_id,
    }).catch(() => {});
  }, delay);
}

app.post('/webhook', async (req, res) => {
  console.log('📥 Вебхук получен:', JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (body.callback_query) {
    const { message, data, from } = body.callback_query;
    const message_id = message.message_id;
    const username = from.username || from.first_name || 'неизвестно';

    const [action, rowRaw] = data.split(':');
    const row = parseInt(rowRaw);

    if (action === 'accept') {
      await axios.post(GAS_WEB_APP_URL, {
        row,
        status: 'В работе',
        executor: `@${username}`,
        message_id
      });

      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id: message.chat.id,
        message_id,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Выполнено', callback_data: `start:${row}` },
            { text: '🚚 Ожидает поставки', callback_data: `wait:${row}` },
            { text: '❌ Отмена', callback_data: `cancel:${row}` }
          ]]
        }
      });

      await sendTelegramMessage(message.chat.id, `🔧 Заявка №${row} принята в работу @${username}`, {
        reply_to_message_id: message.message_id
      });
    }

    if (action === 'start') {
      userState[from.id] = { step: 'awaiting_photo', row, username, message_id };
      await sendTelegramMessage(from.id, '📷 Пришлите фото выполненных работ.');
    }

    if (action === 'wait') {
      await axios.post(GAS_WEB_APP_URL, {
        row,
        status: 'Ожидает поставки',
        executor: `@${username}`,
        message_id
      });

      await sendTelegramMessage(message.chat.id, `📦 Заявка №${row} переведена в статус "Ожидает поставки"`, {
        reply_to_message_id: message.message_id
      });
    }

    if (action === 'cancel') {
      await axios.post(GAS_WEB_APP_URL, {
        row,
        status: 'Отменена',
        executor: `@${username}`,
        message_id
      });

      await sendTelegramMessage(message.chat.id, `❌ Заявка №${row} отменена исполнителем @${username}`, {
        reply_to_message_id: message.message_id
      });
    }

    return res.sendStatus(200);
  }

  const msg = body.message;
  const user = msg?.from;

  if (msg?.photo && userState[user.id]?.step === 'awaiting_photo') {
    const { row, username, message_id } = userState[user.id];
    const photoArray = msg.photo;
    const fileId = photoArray[photoArray.length - 1].file_id;

    try {
      const tempPath = await downloadFile(fileId);
      const driveUrl = await uploadToDrive(tempPath);

      userState[user.id].step = 'awaiting_sum';
      userState[user.id].photoUrl = driveUrl;

      const replyId = await sendTelegramMessage(msg.chat.id, '💰 Введите сумму выполненных работ:');
      messageMap[user.id] = [msg.message_id, replyId];

    } catch (e) {
      console.error('Ошибка загрузки фото:', e.message);
    }

    return res.sendStatus(200);
  }

  if (userState[user.id]?.step === 'awaiting_sum') {
    userState[user.id].sum = msg.text;
    userState[user.id].step = 'awaiting_comment';
    const replyId = await sendTelegramMessage(msg.chat.id, '📝 Добавьте комментарий:');
    messageMap[user.id].push(msg.message_id, replyId);
    return res.sendStatus(200);
  }

  if (userState[user.id]?.step === 'awaiting_comment') {
    const { row, username, message_id, sum, photoUrl } = userState[user.id];
    const comment = msg.text;

    try {
      await axios.post(GAS_WEB_APP_URL, {
        row,
        photo: photoUrl,
        sum,
        comment,
        username,
        message_id
      });

      const finalText = `✅ Заявка #${row} закрыта.\n💰 Сумма: ${sum} сум\n👤 Исполнитель: @${username}`;
      const resultId = await sendTelegramMessage(msg.chat.id, finalText);

      // Удалить промежуточные
      messageMap[user.id].forEach(id => deleteMessage(msg.chat.id, id));
      deleteMessage(msg.chat.id, resultId);

      delete userState[user.id];
    } catch (e) {
      console.error('Ошибка при финальной записи:', e.message);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Сервер Telegram-бота запущен');
});
