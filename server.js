require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const STATE = {}; // Хранение состояний по userId

// ============ Вебхук ============
app.post('/', async (req, res) => {
  const update = req.body;
  console.log('📩 Webhook получен:', JSON.stringify(update, null, 2));

  if (update.callback_query) {
    handleCallback(update.callback_query);
  } else if (update.message) {
    handleMessage(update.message);
  }

  res.sendStatus(200);
});

// ============ Обработка callback ============
async function handleCallback(callbackQuery) {
  const data = callbackQuery.data;
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const username = callbackQuery.from.username || '';
  const messageId = callbackQuery.message.message_id;

  if (data.startsWith('in_progress:')) {
    const [_, row, sourceMessageId] = data.split(':');
    const executorKeyboard = [
      [{ text: '@EvelinaB87', callback_data: `set_executor:${row}:${sourceMessageId}:@EvelinaB87` }],
      [{ text: '@Olim19', callback_data: `set_executor:${row}:${sourceMessageId}:@Olim19` }],
      [{ text: '@Oblayor_04_09', callback_data: `set_executor:${row}:${sourceMessageId}:@Oblayor_04_09` }],
      [{ text: '📝 Текстовой подрядчик', callback_data: `set_executor:${row}:${sourceMessageId}:text` }]
    ];

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Выберите исполнителя для заявки #${row}:`,
      reply_markup: { inline_keyboard: executorKeyboard }
    });
  }

  else if (data.startsWith('set_executor:')) {
    const [_, row, parentMessageId, executor] = data.split(':');
    const selected = executor === 'text';

    if (selected) {
      STATE[userId] = { stage: 'awaiting_custom_executor', row, messageId: parentMessageId };
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `Введите имя исполнителя для заявки #${row}:`
      });
      return;
    }

    // Сохраняем в таблицу
    await axios.post(GAS_URL, {
      row,
      status: 'В работе',
      username: executor
    });

    // Обновляем материнское сообщение
    const buttons = [
      [
        { text: '✅ Выполнено', callback_data: `done:${row}:${parentMessageId}:${executor}` },
        { text: '📦 Ожидает поставки', callback_data: `wait_parts:${row}` },
        { text: '❌ Отмена', callback_data: `cancel:${row}` }
      ]
    ];
    await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: parentMessageId,
      reply_markup: { inline_keyboard: buttons }
    });

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Заявка #${row} принята в работу исполнителем ${executor}`
    });
  }

  else if (data.startsWith('done:')) {
    const [_, row, parentMessageId, executor] = data.split(':');
    STATE[userId] = { stage: 'awaiting_photo', row, messageId: parentMessageId, username: executor };
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Загрузите фото выполненных работ по заявке #${row}`
    });
  }
}

// ============ Обработка сообщений ============
async function handleMessage(message) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const step = STATE[userId];
  if (!step) return;

  if (step.stage === 'awaiting_custom_executor') {
    const executor = message.text.trim();
    await axios.post(GAS_URL, {
      row: step.row,
      status: 'В работе',
      username: executor
    });

    const buttons = [
      [
        { text: '✅ Выполнено', callback_data: `done:${step.row}:${step.messageId}:${executor}` },
        { text: '📦 Ожидает поставки', callback_data: `wait_parts:${step.row}` },
        { text: '❌ Отмена', callback_data: `cancel:${step.row}` }
      ]
    ];
    await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: step.messageId,
      reply_markup: { inline_keyboard: buttons }
    });

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Заявка #${step.row} принята в работу исполнителем ${executor}`
    });

    delete STATE[userId];
  }

  else if (step.stage === 'awaiting_photo' && message.photo) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = fileRes.data.result.file_path;

    const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
    const response = await axios.get(fileUrl, { responseType: 'stream' });

    const fileName = `photo_${Date.now()}.jpg`;
    const localPath = path.join(__dirname, fileName);
    const writer = fs.createWriteStream(localPath);
    response.data.pipe(writer);
    await new Promise(resolve => writer.on('finish', resolve));

    STATE[userId] = { ...step, stage: 'awaiting_sum', photoPath: localPath };
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Введите сумму работ по заявке #${step.row}`
    });
  }

  else if (step.stage === 'awaiting_sum') {
    const sum = message.text.replace(/[^\d]/g, '');
    STATE[userId] = { ...step, stage: 'awaiting_comment', sum };
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `Введите комментарий по заявке #${step.row}`
    });
  }

  else if (step.stage === 'awaiting_comment') {
    const comment = message.text;
    const row = step.row;
    const photoPath = step.photoPath;
    const sum = step.sum;
    const username = step.username;

    // Отправка на Google Apps Script
    const form = new FormData();
    form.append('photo', fs.createReadStream(photoPath));
    form.append('row', row);
    form.append('sum', sum);
    form.append('comment', comment);
    form.append('username', username);

    const uploadRes = await axios.post(GAS_URL, form, {
      headers: form.getHeaders()
    });

    const photoLink = uploadRes.data?.photoLink || '—';
    const delay = uploadRes.data?.delay || 0;
    const pizzeria = uploadRes.data?.pizzeria || '—';
    const problem = uploadRes.data?.problem || '—';

const finalMessage = `
📌 Заявка №${row}
🏬 Пиццерия: ${pizzaNumber || '—'}
📄 Проблема: ${problem || '—'}
💬 Комментарий: ${comment || '—'}
📎 Фото: ${photoLink ? `[Открыть](${photoLink})` : '—'}
💰 Сумма: ${sum || '0'} сум
👤 Исполнитель: @${executor || '—'}
✅ Статус: Выполнено
⏰ Просрочка: ${delay || '0'} дн.
`;

    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: message.chat.id,
      message_id: step.messageId,
      text: finalText,
      parse_mode: 'Markdown'
    });

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Заявка #${row} успешно закрыта!`
    });

    // Удаляем файл
    fs.unlinkSync(photoPath);
    delete STATE[userId];
  }
}

// ============ Запуск сервера ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
