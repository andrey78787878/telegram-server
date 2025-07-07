require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwYycNWHJanlUL-vDM6KptXod9GdbzcVa6HI67ttSfRkIPkSYuDQdiEzGCDkRHSKkLV/exec';
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function log(...args) {
  console.log('[LOG]', ...args);
}

// Webhook handler
app.post('/callback', async (req, res) => {
  try {
    const body = req.body;
    log('Body:', JSON.stringify(body));

    if (body.message) {
      const chatId = body.message.chat.id;
      const messageId = body.message.message_id;
      const text = body.message.text || '';

      if (text === '/start') {
        await sendMessage(chatId, 'Бот запущен. Ожидаю команды.');
      }
    }

    if (body.callback_query) {
      const query = body.callback_query;
      const data = query.data;
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;
      const fromUsername = query.from.username ? `@${query.from.username}` : query.from.first_name;

      log('Callback data:', data);

      if (data.startsWith('accept_')) {
        const row = data.split('_')[1];
        const keyboard = EXECUTORS.map((name) => [{ text: name, callback_data: `executor_${row}_${name}` }]);
        await editMessageText(chatId, messageId, 'Выберите исполнителя:', keyboard);
      }

      if (data.startsWith('executor_')) {
        const [, row, executor] = data.split('_');

        await axios.post(GAS_WEB_APP_URL, {
          row,
          status: 'В работе',
          executor,
          message_id: messageId,
        });

        await editMessageText(chatId, messageId, `Заявка #${row} принята в работу исполнителем ${executor}`, [
          [
            { text: 'Выполнено ✅', callback_data: `done_${row}` },
            { text: 'Ожидает поставки 📦', callback_data: `wait_${row}` },
            { text: 'Отмена ❌', callback_data: `cancel_${row}` }
          ]
        ]);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Callback error:', error);
    res.sendStatus(500);
  }
});

async function sendMessage(chatId, text, inlineKeyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };
  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  return axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}

async function editMessageText(chatId, messageId, text, inlineKeyboard = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  };
  if (inlineKeyboard) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  return axios.post(`${TELEGRAM_API}/editMessageText`, payload);
}

app.listen(PORT, () => {
  log(`🚀 Server running on port ${PORT}`);
});
