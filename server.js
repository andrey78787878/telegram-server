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
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 3000;

const userStates = {};

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // 📌 CALLBACK (нажатие кнопок)
  if (body.callback_query) {
    const chatId = body.callback_query.message.chat.id;
    const messageId = body.callback_query.message.message_id;
    const data = body.callback_query.data;
    const [action, executor] = data.split(':');
    const messageText = body.callback_query.message.text;

    // Сохраняем состояние пользователя
    userStates[chatId] = userStates[chatId] || {};
    userStates[chatId].action = action;
    userStates[chatId].messageId = messageId;

    if (action === 'select_executor' && executor) {
      if (executor === 'Текстовой подрядчик') {
        userStates[chatId].stage = 'awaiting_executor_name';
        await sendMessage(chatId, 'Введите имя подрядчика вручную:');
      } else {
        userStates[chatId].executor = executor;
        await sendMessage(chatId, `Выбран исполнитель: ${executor}`);
      }
      return res.sendStatus(200);
    }

    if (action === 'done') {
      userStates[chatId].stage = 'awaiting_photo';
      await sendMessage(chatId, 'Загрузите фото выполненных работ 📸');
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  }

  // 📎 Фото
  if (body.message?.photo) {
    const chatId = body.message.chat.id;
    const fileId = body.message.photo.at(-1).file_id;

    if (userStates[chatId]?.stage === 'awaiting_photo') {
      const fileUrl = await getFileUrl(fileId);
      const photoBuffer = await downloadFile(fileUrl);
      const fileName = `photo_${Date.now()}.jpg`;
      fs.writeFileSync(fileName, photoBuffer);

      const driveLink = await uploadToDrive(fileName);
      fs.unlinkSync(fileName);

      userStates[chatId].photoUrl = driveLink;
      userStates[chatId].stage = 'awaiting_sum';

      await sendMessage(chatId, 'Введите сумму работ 💰');
      return res.sendStatus(200);
    }
  }

  // 💬 Текст
  if (body.message?.text) {
    const chatId = body.message.chat.id;
    const text = body.message.text;

    userStates[chatId] = userStates[chatId] || {};

    if (userStates[chatId].stage === 'awaiting_executor_name') {
      userStates[chatId].executor = text;
      userStates[chatId].stage = null;
      await sendMessage(chatId, `Выбран подрядчик: ${text}`);
      return res.sendStatus(200);
    }

    if (userStates[chatId].stage === 'awaiting_sum') {
      userStates[chatId].sum = text;
      userStates[chatId].stage = 'awaiting_comment';
      await sendMessage(chatId, 'Добавьте комментарий 📌');
      return res.sendStatus(200);
    }

    if (userStates[chatId].stage === 'awaiting_comment') {
      userStates[chatId].comment = text;
      userStates[chatId].stage = null;

      // Отправка в GAS
      const payload = {
        photo: userStates[chatId].photoUrl,
        sum: userStates[chatId].sum,
        comment: userStates[chatId].comment,
        executor: userStates[chatId].executor || '',
        message_id: userStates[chatId].messageId,
        username: body.message.from?.username || '',
      };

      await axios.post(GAS_WEB_APP_URL, payload);
      await sendMessage(chatId, '✅ Данные сохранены и заявка закрыта');

      // Обновление сообщения через 2 мин
      setTimeout(async () => {
        try {
          const { data } = await axios.get(`${GAS_WEB_APP_URL}?message_id=${userStates[chatId].messageId}`);
          if (data && data.photo && data.sum && data.executor && data.status && data.delay !== undefined) {
            const caption = `📌 Заявка #${data.row} закрыта.\n📎 Фото: ${data.photo}\n💰 Сумма: ${data.sum} сум\n👤 Исполнитель: ${data.executor}\n✅ Статус: ${data.status}\nПросрочка: ${data.delay} дн.`;
            await axios.post(`${TELEGRAM_API}/editMessageText`, {
              chat_id: chatId,
              message_id: userStates[chatId].messageId,
              text: caption,
            });
          }
        } catch (err) {
          console.error('⛔ Ошибка при обновлении сообщения:', err.message);
        }
      }, 2 * 60 * 1000);

      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

// ===========================
// 🔧 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ===========================
async function sendMessage(chatId, text) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

async function getFileUrl(fileId) {
  const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${data.result.file_path}`;
}

async function downloadFile(fileUrl) {
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return response.data;
}

async function uploadToDrive(filePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'),
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const driveService = google.drive({ version: 'v3', auth });
  const fileMetadata = {
    name: path.basename(filePath),
    parents: ['1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF'], // твоя папка
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath),
  };

  const { data } = await driveService.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  // Сделать файл общедоступным
  await driveService.permissions.create({
    fileId: data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  return `https://drive.google.com/uc?id=${data.id}`;
}

// ===========================
// 🚀 СТАРТ СЕРВЕРА
// ===========================
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
