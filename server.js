const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000; // Render использует PORT

// === Настройки ===
const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzAgqVRP9B_PLFEGrWmFyS3LEdhgWEtTQNuUwDU0SvN4ReemB7uf13PmCnvedXnnZVK/exec';
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // === Обработка нажатий на кнопки ===
  if (body.callback_query) {
    const callbackQuery = body.callback_query;
    const callbackData = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    const chatId = callbackQuery.message.chat.id;

    try {
      // Ответ на нажатие
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackQuery.id,
        text: '✅ Выбор зарегистрирован',
        show_alert: false
      });

      // Удаление кнопок
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {}
      });
    } catch (err) {
      console.error('Ошибка при ответе или удалении кнопок:', err.message);
    }

    // Определение действия
    let responseText = '';
    let row = null;

    if (callbackData.startsWith('accept_')) {
      responseText = 'Принято в работу';
      row = parseInt(callbackData.replace('accept_', ''), 10);
    } else if (callbackData.startsWith('cancel_')) {
      responseText = 'Отмена';
      row = parseInt(callbackData.replace('cancel_', ''), 10);
    } else if (callbackData.startsWith('done_')) {
      responseText = 'Выполнено';
      row = parseInt(callbackData.replace('done_', ''), 10);
    } else if (callbackData.startsWith('waiting_')) {
      responseText = 'Ожидает поставки комплектующих';
      row = parseInt(callbackData.replace('waiting_', ''), 10);
    }

    try {
      if (row) {
        await axios.post(WEB_APP_URL, {
          row: row,
          response: responseText
        });

        console.log(`📩 Ответ "${responseText}" отправлен для заявки #${row}`);
      } else {
        await axios.post(WEB_APP_URL, {
          message_id: messageId,
          response: responseText
        });

        console.log(`📩 Ответ "${responseText}" отправлен для message_id: ${messageId}`);
      }
    } catch (error) {
      console.error('❌ Ошибка при отправке в Web App:', error.message);
    }

    return res.sendStatus(200);
  }

  // === Обработка обычных сообщений ===
  if (body.message) {
    const message = body.message;
    const from = message.from.first_name || message.from.username || 'неизвестный';
    const text = message.text || '';
    const chatId = message.chat.id;

    console.log(`📩 Новое сообщение от ${from}: ${text}`);

    // Обработка команды типа /13
    const match = text.match(/^\/(\d{1,4})$/);
    if (match) {
      const row = parseInt(match[1], 10);

      const responseText = `Выберите действие для заявки №${row}:`;
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Выполнено', callback_data: `done_${row}` },
            { text: '❌ Отменено', callback_data: `cancel_${row}` }
          ],
          [
            { text: '⏳ Ожидает поставки комплектующих', callback_data: `waiting_${row}` }
          ]
        ]
      };

      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: responseText,
          reply_markup: JSON.stringify(keyboard)
        });
      } catch (err) {
        console.error('Ошибка при отправке сообщения с кнопками:', err.message);
      }

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
