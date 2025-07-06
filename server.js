require('dotenv').config(); // Загружаем переменные из .env

const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

const { BOT_TOKEN, TELEGRAM_API } = require('./config');
const handleCallbackQuery = require('./messageUtils'); // если есть
const bodyParser = require('body-parser');

app.use(bodyParser.json());

// Проверка переменных окружения
if (!process.env.GAS_WEB_APP_URL) {
  console.error('❌ GAS_WEB_APP_URL не определён! Проверь .env');
  process.exit(1); // Прерываем запуск сервера
}

// Webhook от Telegram
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Проверка callback от кнопки
    if (body.callback_query) {
      const callbackData = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = body.callback_query.from.username;

      console.log(`➡️ Обработка кнопки: ${callbackData}, заявка ID: ${callbackData.split('_')[1]}, от пользователя: @${username}`);

      const payload = {
        data: callbackData,
        message_id: messageId,
        username: '@' + username
      };

      console.log('📤 Отправка в GAS:', process.env.GAS_WEB_APP_URL);

      const response = await axios.post(process.env.GAS_WEB_APP_URL, payload);
      console.log('✅ Ответ от GAS:', response.data);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Ошибка в webhook:', error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

