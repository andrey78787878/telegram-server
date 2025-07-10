require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// === Переменные окружения ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// === Кнопки ===

function createMainKeyboard(messageId) {
  return {
    inline_keyboard: [
      [
        { text: 'Принято в работу', callback_data: `accept_${messageId}` }
      ]
    ]
  };
}

function createInProgressKeyboard(messageId) {
  return {
    inline_keyboard: [
      [
        { text: 'Выполнено', callback_data: `done_${messageId}` },
        { text: 'Ожидает поставки', callback_data: `wait_${messageId}` },
        { text: 'Отмена', callback_data: `cancel_${messageId}` }
      ]
    ]
  };
}

// === Вебхук ===

app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('📩 Входящий запрос:', JSON.stringify(body, null, 2)); // ← ЛОГ

  try {
    // Обработка обычных сообщений (например, отправка заявки)
    if (body.message) {
      const chatId = body.message.chat.id;
      const messageId = body.message.message_id;
      const username = body.message.from.username || 'без_ника';

      console.log(`✉️ Новое сообщение от @${username}, chat_id: ${chatId}, message_id: ${messageId}`);

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `📌 Новая заявка #${messageId}`,
        reply_markup: createMainKeyboard(messageId)
      });

    } else if (body.callback_query) {
      // Обработка нажатий кнопок
      const callbackId = body.callback_query.id;
      const data = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const username = body.callback_query.from.username || 'без_ника';
      const messageId = body.callback_query.message.message_id;

      console.log(`🖱 Нажата кнопка: ${data} от @${username}, message_id: ${messageId}`);

      // Подтвердим нажатие кнопки (визуально)
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callbackId
      });

      const [action, msgId] = data.split('_');

      if (!action || !msgId) {
        console.log('⚠️ Ошибка в callback_data');
        return res.sendStatus(200);
      }

      if (action === 'accept') {
        // Обновляем статус заявки
        console.log(`✅ Принято в работу: заявка ${msgId} исполнителем @${username}`);

        await axios.post(GAS_WEB_APP_URL, {
          status: 'В работе',
          message_id: msgId,
          executor: `@${username}`
        });

        // Обновляем кнопки
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: createInProgressKeyboard(msgId)
        });

        // Уведомление
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          reply_to_message_id: messageId,
          text: `👤 Заявка принята в работу исполнителем @${username}`
        });

      } else if (action === 'done') {
        // Начало логики "выполнено"
        console.log(`📸 Запрос фото по заявке ${msgId}`);

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          reply_to_message_id: messageId,
          text: `📸 Пожалуйста, пришлите фото выполненных работ.`
        });

        // 👉 Здесь начинается следующая логика: ждём фото, сумму, комментарий — она должна быть в другом блоке обработки сообщений.

      } else if (action === 'wait' || action === 'cancel') {
        const statusText = action === 'wait' ? 'Ожидает поставки' : 'Отменено';
        console.log(`🔁 Заявка ${msgId} получила статус: ${statusText}`);

        await axios.post(GAS_WEB_APP_URL, {
          status: statusText,
          message_id: msgId,
          executor: `@${username}`
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          reply_to_message_id: messageId,
          text: `Заявка #${msgId} получила статус: *${statusText}*`,
          parse_mode: 'Markdown'
        });
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Ошибка в обработке запроса:', error.message);
    res.sendStatus(500);
  }
});

// === Запуск сервера ===

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Server is running on port ${PORT}`);
});
