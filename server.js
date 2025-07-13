require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 3000;

const userStates = {}; // для хранения состояния пользователей

// Подключаем логику Telegram (обработка callback и сообщений)
const setupTelegramHandlers = require('./telegram-handlers');
setupTelegramHandlers(app, userStates);

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
