require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL || 'https://script.google.com/macros/s/AKfycbwYycNWHJanlUL-vDM6KptXod9GdbzcVa6HI67ttSfRkIPkSYuDQdiEzGCDkRHSKkLV/exec';


// ================== Лог всех входящих запросов ==================
console.log('📩 Получен апдейт от Telegram:', JSON.stringify(req.body, null, 2));

app.post('/webhook', async (req, res) => {
  console.log('🔥 Webhook received:', JSON.stringify(req.body, null, 2));

  if (req.body.message) {
    const message = req.body.message;
    const chatId = message.chat.id;

    // Пример отправки кнопки
    if (message.text === '/start') {
      await sendInlineKeyboard(chatId, message.message_id);
    }
  }

  if (req.body.callback_query) {
    const callback = req.body.callback_query;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    const data = callback.data;
    const username = callback.from.username;

    console.log('✅ Нажата кнопка:', data);

    if (data === 'accept') {
      await axios.post(GAS_WEB_APP_URL, {
        action: 'accept',
        message_id: messageId,
        username: username
      });
      await editMessage(chatId, messageId, `✅ Принято в работу от @${username}`);
    }

    if (data === 'cancel') {
      await axios.post(GAS_WEB_APP_URL, {
        action: 'cancel',
        message_id: messageId,
        username: username
      });
      await editMessage(chatId, messageId, `❌ Отменено пользователем @${username}`);
    }

    // Обязательно отвечай на callback
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callback.id,
      text: 'Обработано ✅',
      show_alert: false
    });
  }

  res.sendStatus(200);
});

// =============== Функция отправки инлайн-кнопок ===============
async function sendInlineKeyboard(chatId, replyToMessageId) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Принято в работу', callback_data: 'accept' },
        { text: 'Отмена', callback_data: 'cancel' }
      ]
    ]
  };

  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: 'Выберите действие:',
    reply_to_message_id: replyToMessageId,
    reply_markup: keyboard
  });
}

// =============== Функция редактирования сообщения ===============
async function editMessage(chatId, messageId, newText) {
  await axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text: newText
  });
}

// =================== Запуск сервера ===================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
