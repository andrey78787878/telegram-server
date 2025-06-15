const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000; // Render использует PORT

// === Настройки ===
const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwufpfsXKLzGfNE7QqzzOMlnOi2-7w7FdrkwFgO2-xKDXd44QOjxEmbGZdD0bOSEyfd/exec';

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // === Обработка нажатий на кнопки ===
  if (body.callback_query) {
    const callbackQuery = body.callback_query;
    const callbackData = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;

    try {
      // Ответ на нажатие
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackQuery.id,
        text: '✅ Выбор зарегистрирован',
        show_alert: false
      });

      // Удаление кнопок
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
        chat_id: callbackQuery.message.chat.id,
        message_id: messageId,
        reply_markup: {} // пустой объект = удалить клавиатуру
      });
    } catch (err) {
      console.error('Ошибка при ответе или удалении кнопок:', err.message);
    }

    // Определение действия
    let responseText = '';
    if (callbackData.startsWith('accept_')) {
      responseText = 'Принято в работу';
    } else if (callbackData.startsWith('cancel_')) {
      responseText = 'Отмена';
    } else {
      responseText = 'Неизвестное действие';
    }

    try {
      await axios.post(WEB_APP_URL, {
        message_id: messageId,
        response: responseText
      });

      console.log(`📩 Ответ "${responseText}" отправлен для message_id: ${messageId}`);
    } catch (error) {
      console.error('❌ Ошибка при отправке в Web App:', error.message);
    }

    return res.sendStatus(200);
  }

  // === Обработка обычных сообщений ===
  if (body.message) {
    const from = body.message.from.first_name || body.message.from.username || 'неизвестный';
    const text = body.message.text || '';
    console.log(`📩 Новое сообщение от ${from}: ${text}`);
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
