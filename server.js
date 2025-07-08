require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '📝 Текстовой подрядчик'];
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// Хранилище шагов
const steps = {};

app.post('/', async (req, res) => {
  res.send('📩 Webhook получен');

  const body = req.body;
  if (body.message) await handleMessage(body.message);
  else if (body.callback_query) await handleCallback(body.callback_query);
});

async function handleCallback(callback) {
  const chat_id = callback.message.chat.id;
  const message_id = callback.message.message_id;
  const data = callback.data;
  const from = callback.from.username;

  if (data.startsWith('in_progress:')) {
    const [_, row, msgId] = data.split(':');

    const keyboard = EXECUTORS.map(name => ([{
      text: name,
      callback_data: `set_executor:${row}:${msgId}:${name}`
    }]));

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: '👤 Выберите исполнителя:',
      reply_to_message_id: Number(msgId),
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  else if (data.startsWith('set_executor:')) {
    const [_, row, msgId, executor] = data.split(':');

    let finalExecutor = executor;
    if (executor === '📝 Текстовой подрядчик') {
      steps[chat_id] = { step: 'wait_executor_text', row, msgId };
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '✏️ Введите имя подрядчика:',
        reply_to_message_id: Number(msgId)
      });
    } else {
      await setExecutorAndShowActions(chat_id, row, msgId, finalExecutor);
    }
  }

  else if (data.startsWith('status:done')) {
    const [_, row, msgId, executor] = data.split(':');
    steps[chat_id] = {
      step: 'wait_photo',
      row,
      msgId,
      username: executor.replace('@', '')
    };

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: '📸 Отправьте фото выполненной работы:',
      reply_to_message_id: Number(msgId)
    });
  }
}

async function handleMessage(msg) {
  const chat_id = msg.chat.id;
  const stepData = steps[chat_id];

  if (!stepData) return;

  // Ввод текстового исполнителя
  if (stepData.step === 'wait_executor_text') {
    const finalExecutor = msg.text;
    await setExecutorAndShowActions(chat_id, stepData.row, stepData.msgId, finalExecutor);
    delete steps[chat_id];
  }

  // Фото
  else if (stepData.step === 'wait_photo' && msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileLink = await getTelegramFileLink(fileId);
    const photoPath = await downloadFile(fileLink);
    const photoLink = await uploadToDrive(photoPath);

    stepData.photoLink = photoLink;
    steps[chat_id].step = 'wait_sum';

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: '💰 Введите сумму работ в сумах:',
      reply_to_message_id: msg.message_id
    });
  }

  // Сумма
  else if (stepData.step === 'wait_sum') {
    steps[chat_id].sum = msg.text;
    steps[chat_id].step = 'wait_comment';

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: '💬 Напишите комментарий к выполненной работе:',
      reply_to_message_id: msg.message_id
    });
  }

  // Комментарий
  else if (stepData.step === 'wait_comment') {
    steps[chat_id].comment = msg.text;

    // Запрос в GAS
    await axios.post(GAS_WEB_APP_URL, {
      row: stepData.row,
      message_id: stepData.msgId,
      username: stepData.username,
      sum: stepData.sum,
      comment: stepData.comment,
      photo: stepData.photoLink
    });

    // Финальное сообщение
    const pizzeria = stepData.pizzeria || '❓';
    const problem = stepData.problem || 'Нет данных';
    const delay = stepData.delay || '0';

    const finalText = `🏬 Пиццерия: #${pizzeria}\n🛠 Проблема: ${problem}\n💬 Комментарий: ${stepData.comment}\n\n📌 Заявка #${stepData.row} закрыта.\n📎 Фото: [ссылка](${stepData.photoLink})\n💰 Сумма: ${stepData.sum} сум\n👤 Исполнитель: @${stepData.username}\n✅ Статус: Выполнено\n⏰ Просрочка: ${delay} дн.`;

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: finalText,
      parse_mode: 'Markdown'
    });

    delete steps[chat_id];
  }
}

// ==================== Утилиты ====================

async function setExecutorAndShowActions(chat_id, row, msgId, executor) {
  await axios.post(GAS_WEB_APP_URL, {
    row,
    executor,
    status: 'В работе'
  });

  const inline_keyboard = [[
    {
      text: '✅ Выполнено',
      callback_data: `status:done:${row}:${msgId}:${executor}`
    }
  ]];

  await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    chat_id,
    message_id: Number(msgId),
    reply_markup: { inline_keyboard }
  });

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text: `👤 Исполнитель @${executor} назначен. Заявка принята в работу.`,
    reply_to_message_id: Number(msgId)
  });
}

async function getTelegramFileLink(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${res.data.result.file_path}`;
}

async function downloadFile(url) {
  const fileName = path.join(TEMP_DIR, `${Date.now()}.jpg`);
  const writer = fs.createWriteStream(fileName);

  const res = await axios.get(url, { responseType: 'stream' });
  res.data.pipe(writer);

  return new Promise((resolve) => {
    writer.on('finish', () => resolve(fileName));
  });
}

async function uploadToDrive(filePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  const drive = google.drive({ version: 'v3', auth });
  const fileMetadata = {
    name: path.basename(filePath),
    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
  };

  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath)
  };

  const res = await drive.files.create({
    resource: fileMetadata,
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

  return `https://drive.google.com/uc?id=${fileId}`;
}

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
