require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const app = express();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 3000;

app.use(express.json());

const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];
const userStates = {};
const log = (label, data) => {
  console.log(`\n[${label}]`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
};

app.post('/callback', async (req, res) => {
  const body = req.body;
  log('callback_query', body);

  const callback = body.callback_query;
  if (!callback) return res.sendStatus(200);

  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const username = callback.from.username || 'Без имени';
  const data = callback.data;

  if (data === 'accept') {
    const keyboard = EXECUTORS.map(name => [{ text: name, callback_data: `executor_${name}` }]);
    return await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  if (data.startsWith('executor_')) {
    const executor = data.replace('executor_', '');
    const row = callback.message.text.match(/Заявка №(\d+)/)?.[1];

    await axios.post(GAS_WEB_APP_URL, {
      action: 'set_executor', row, executor, status: 'in_progress'
    });

    return await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text: `✅ Заявка #${row} принята\n👤 Исполнитель: ${executor}`,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Выполнено ✅', callback_data: `status:done:${row}` },
          { text: 'Ожидает поставки ⏳', callback_data: `status:delayed:${row}` },
          { text: 'Отмена ❌', callback_data: `status:cancelled:${row}` }
        ]]
      }
    });
  }

  const [prefix, status, row] = data.split(':');
  if (prefix !== 'status') return res.sendStatus(200);

  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
    callback_query_id: callback.id,
    text: `Статус: ${status}`,
    show_alert: false
  });

  if (status === 'done') {
    userStates[chatId] = { stage: 'awaiting_photo', row };
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: '📷 Пожалуйста, отправьте фото выполненной работы.'
    });
  } else {
    await axios.post(GAS_WEB_APP_URL, {
      row,
      status,
      username,
      message_id: messageId
    });

    await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    });

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Заявка #${row} закрыта статусом: ${status}`,
      reply_to_message_id: messageId
    });
  }

  res.sendStatus(200);
});

app.post('/message', async (req, res) => {
  const msg = req.body.message;
  if (!msg || !userStates[msg.chat.id]) return res.sendStatus(200);

  const state = userStates[msg.chat.id];

  try {
    if (state.stage === 'awaiting_photo' && msg.photo) {
      const fileId = msg.photo.at(-1).file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

      userStates[msg.chat.id].photo = fileUrl;
      userStates[msg.chat.id].stage = 'awaiting_sum';

      return await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: msg.chat.id,
        text: '💰 Укажите сумму выполненных работ (в сумах):'
      });
    } else if (state.stage === 'awaiting_sum' && msg.text) {
      userStates[msg.chat.id].sum = msg.text;
      userStates[msg.chat.id].stage = 'awaiting_comment';

      return await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: msg.chat.id,
        text: '💬 Добавьте комментарий к заявке:'
      });
    } else if (state.stage === 'awaiting_comment' && msg.text) {
      const { row, photo, sum } = state;
      const comment = msg.text;

      await axios.post(GAS_WEB_APP_URL, {
        row, status: 'done', photo, sum, comment
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: msg.chat.id,
        text: `✅ Заявка #${row} закрыта\n📷 Фото: ${photo}\n💰 Сумма: ${sum}\n💬 Комментарий: ${comment}`
      });

      delete userStates[msg.chat.id];
    }
  } catch (err) {
    console.error('[message handling error]', err.response?.data || err.message);
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Бот работает ✅');
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
