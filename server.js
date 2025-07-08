require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

const userSteps = new Map(); // шаги по пользователю
const tempData = new Map(); // временные данные по заявке

app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    console.log('📩 Webhook получен:', JSON.stringify(update, null, 2));

    // Кнопки
    if (update.callback_query) {
      const callbackData = update.callback_query.data;
      const chatId = update.callback_query.message.chat.id;
      const messageId = update.callback_query.message.message_id;
      const username = update.callback_query.from.username || 'Без_ника';

      // Принятие в работу
      if (callbackData.startsWith('accept_')) {
        const row = callbackData.split('_')[1];

        // Кнопки с выбором исполнителя
        const buttons = EXECUTORS.map(name => ([{
          text: name,
          callback_data: `set_executor_${row}_${name}`
        }]));

        await sendMessage(chatId, 'Выберите исполнителя или введите вручную:', {
          reply_markup: { inline_keyboard: buttons }
        });

        return res.sendStatus(200);
      }

      // Выбор исполнителя
      if (callbackData.startsWith('in_progress:')) {
  const [_, row, messageId] = callback_data.split('__');
  const executorKeyboard = [
    [{ text: '@EvelinaB87', callbackdata: `set_executor__${row}:${messageId}:@EvelinaB87` }],
    [{ text: '@Olim19', callbackdata: `set_executor:${row}__${messageId}:@Olim19` }],
    [{ text: '@Oblayor_04_09', callbackdata: `set_executor__${row}:${messageId}:@Oblayor_04_09` }],
    [{ text: '📝 Текстовой подрядчик', callbackdata: `set_executor__${row}:${messageId}:text` }]
  ];

  console.log('➡️ Выбор исполнителя для заявки', row);

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text: `Выберите исполнителя для заявки #${row}:`,
    reply_markup: {
      inline_keyboard: executorKeyboard
    }
  });

  return res.sendStatus(200);
      }

      // Выполнено
      if (callbackData.startsWith('done_')) {
        const [_, row, name] = callbackData.split('_');
        userSteps.set(chatId, { step: 'wait_photo', row, username: name });
        await sendMessage(chatId, '📸 Отправьте фото выполненной работы:');
        return res.sendStatus(200);
      }

      // Ожидает поставки
      if (callbackData.startsWith('set_executor:')) {
  const [_, row, messageId, executorRaw] = callbackData.split(':');
  const chatId = update.callback_query.message.chat.id;
  const username = executorRaw === 'text' ? null : executorRaw.replace('@', '');

  if (username) {
    // Назначен исполнитель из списка
    await updateExecutor(row, username);
    await sendMessage(chatId, `✅ Назначен исполнитель: @${username}`);

    await sendMessage(chatId, 'Выберите дальнейшее действие:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Выполнено ✅', callback_data: `done_${row}_${username}` }],
          [{ text: 'Ожидает поставки 🕐', callback_data: `delay_${row}_${username}` }],
          [{ text: 'Отмена ❌', callback_data: `cancel_${row}` }]
        ]
      }
    });
  } else {
    // Запрос ввода вручную
    userSteps.set(chatId, { step: 'wait_custom_executor', row });
    await sendMessage(chatId, 'Введите имя исполнителя вручную:');
  }

  return res.sendStatus(200);
}
    }

    // Сообщения пользователя
    if (update.message) {
      const chatId = update.message.chat.id;
      const stepData = userSteps.get(chatId);

      // Если пользователь вводит имя исполнителя вручную
      if (stepData?.step === 'wait_custom_executor') {
        await updateExecutor(stepData.row, update.message.text);
        await sendMessage(chatId, `✅ Назначен исполнитель: ${update.message.text}`);
        await sendMessage(chatId, 'Выберите дальнейшее действие:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Выполнено ✅', callback_data: `done_${stepData.row}_${update.message.text}` }],
              [{ text: 'Ожидает поставки 🕐', callback_data: `delay_${stepData.row}_${update.message.text}` }],
              [{ text: 'Отмена ❌', callback_data: `cancel_${stepData.row}` }]
            ]
          }
        });
        userSteps.delete(chatId);
        return res.sendStatus(200);
      }

      // Фото
      if (stepData?.step === 'wait_photo' && update.message.photo) {
        const fileId = update.message.photo.pop().file_id;
        const fileUrl = await getFileUrl(fileId);
        const filePath = await downloadFile(fileUrl);
        const photoLink = await uploadToDrive(filePath);

        tempData.set(chatId, { ...stepData, photoLink });
        userSteps.set(chatId, { ...stepData, step: 'wait_sum' });
        await sendMessage(chatId, '💰 Введите сумму:');
        return res.sendStatus(200);
      }

      // Сумма
      if (stepData?.step === 'wait_sum') {
        tempData.set(chatId, { ...stepData, sum: update.message.text });
        userSteps.set(chatId, { ...stepData, step: 'wait_comment' });
        await sendMessage(chatId, '💬 Введите комментарий:');
        return res.sendStatus(200);
      }

      // Комментарий и завершение
      if (stepData?.step === 'wait_comment') {
        const finalData = tempData.get(chatId);
        const comment = update.message.text;

        const payload = {
          row: finalData.row,
          photo: finalData.photoLink,
          sum: finalData.sum,
          comment: comment,
          username: finalData.username,
        };

        await axios.post(GAS_WEB_APP_URL, payload);
        const response = await axios.post(`${GAS_WEB_APP_URL}?get_row_info=true`, { row: finalData.row });

        const { pizzeria, problem, delay } = response.data;

        const text = `
🏬 Пиццерия: #${pizzeria}
🛠 Проблема: ${problem}
💬 Комментарий: ${comment}

📌 Заявка #${finalData.row} закрыта.
📎 Фото: [ссылка](${finalData.photoLink})
💰 Сумма: ${finalData.sum} сум
👤 Исполнитель: @${finalData.username}
✅ Статус: Выполнено
⏰ Просрочка: ${delay} дн.
`;

        await sendMessage(chatId, text, { parse_mode: 'Markdown' });
        userSteps.delete(chatId);
        tempData.delete(chatId);
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки вебхука:', err);
    res.sendStatus(500);
  }
});

// === Утилиты ===

async function sendMessage(chatId, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...options
  });
}

async function editMessage(chatId, messageId, options = {}) {
  return axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    chat_id: chatId,
    message_id: messageId,
    ...options
  });
}

async function getFileUrl(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = res.data.result.file_path;
  return `${TELEGRAM_FILE_API}/${filePath}`;
}

async function downloadFile(fileUrl) {
  const fileName = 'photo.jpg';
  const localPath = path.join(__dirname, fileName);
  const writer = fs.createWriteStream(localPath);

  const res = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
  res.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(localPath));
    writer.on('error', reject);
  });
}

async function uploadToDrive(filePath) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(fs.readFileSync('./credentials.json')),
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  const drive = google.drive({ version: 'v3', auth });
  const fileMeta = {
    name: path.basename(filePath),
    parents: [process.env.DRIVE_FOLDER_ID]
  };

  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath)
  };

  const res = await drive.files.create({
    resource: fileMeta,
    media,
    fields: 'id'
  });

  const fileId = res.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });

  fs.unlinkSync(filePath); // Удаляем локально
  return `https://drive.google.com/uc?id=${fileId}`;
}

async function updateExecutor(row, executor) {
  await axios.post(GAS_WEB_APP_URL, {
    row,
    status: 'В работе',
    executor
  });
}

async function updateStatus(row, status, executor = '') {
  await axios.post(GAS_WEB_APP_URL, {
    row,
    status,
    executor
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
