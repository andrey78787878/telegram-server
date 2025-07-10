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

const userStates = {}; // Для отслеживания контекста пользователя

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const state = userStates[userId];

  if (!state || !state.step) return;

  try {
    if (state.step === 'waiting_photo') {
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        state.photoFileId = fileId;
        state.step = 'waiting_sum';

        await bot.sendMessage(chatId, '📌 Укажите сумму работ в сумах:');
      } else {
        await bot.sendMessage(chatId, '⚠️ Пожалуйста, пришлите именно фото.');
      }
    } else if (state.step === 'waiting_sum') {
      const sum = msg.text?.replace(/\D/g, '');
      if (sum) {
        state.sum = sum;
        state.step = 'waiting_comment';

        await bot.sendMessage(chatId, '✏️ Укажите комментарий к заявке или отправьте "-"');
      } else {
        await bot.sendMessage(chatId, '⚠️ Введите числовую сумму без текста.');
      }
    } else if (state.step === 'waiting_comment') {
      state.comment = msg.text || '-';
      state.step = 'processing';

      await bot.sendMessage(chatId, '⏳ Обработка данных...');

      const fileLink = await downloadTelegramFile(state.photoFileId);
      const driveLink = await uploadToDriveAndGetLink(fileLink);

      const payload = {
        photo: driveLink,
        sum: state.sum,
        comment: state.comment,
        message_id: state.message_id,
        row: state.row,
        username: `@${msg.from.username || msg.from.first_name}`,
        executor: `@${msg.from.username || msg.from.first_name}`
      };

      await axios.post(`${process.env.GAS_WEB_APP_URL}`, payload);

      await bot.sendMessage(chatId, `✅ Заявка #${state.row} закрыта. 💰 Сумма: ${state.sum} сум. 👤 Исполнитель: @${msg.from.username || msg.from.first_name}`);

      delete userStates[userId];
    }
  } catch (error) {
    console.error('❌ Ошибка при обработке сообщения:', error);
    await bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте снова или обратитесь к администратору.');
    delete userStates[userId];
  }
});

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
