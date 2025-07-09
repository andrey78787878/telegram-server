require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

// Состояния пользователей
const userStates = new Map();

// --- Удаление сообщений через 60 секунд
async function deleteMessageLater(chatId, messageId) {
  setTimeout(async () => {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (e) {
      console.error('Ошибка удаления сообщения:', e.response?.data);
    }
  }, 60_000);
}

// --- Обработка входящих обновлений от Telegram
app.post(`/webhook`, async (req, res) => {
  const body = req.body;

  // === 📩 callback_query (нажатие кнопки)
  if (body.callback_query) {
    const { data, message, from } = body.callback_query;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const username = from.username;

    if (data.startsWith('status:')) {
      const status = data.split(':')[1];
      const row = message.message_id;
      if (status === 'Принято в работу') {
        // Обновить кнопку и отправить на GAS
        await axios.post(GAS_WEB_APP_URL, {
          message_id: row,
          status: 'В работе',
          executor: `@${username}`,
        });

        // Обновляем кнопки
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Выполнено ✅', callback_data: 'status:Выполнено' },
              { text: 'Ожидает поставки ⏳', callback_data: 'status:Ожидает поставки' },
              { text: 'Отмена ❌', callback_data: 'status:Отмена' }
            ]]
          }
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Заявка #${row} принята в работу исполнителем @${username}`,
          reply_to_message_id: messageId,
        });

      } else if (status === 'Выполнено') {
        // Начинаем цепочку ввода: фото -> сумма -> комментарий
        userStates.set(chatId, {
          step: 'awaiting_photo',
          row,
          username,
          messageId,
        });
        const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '📷 Пожалуйста, отправьте фото выполненных работ:',
        });
        deleteMessageLater(chatId, m.data.result.message_id);

      } else {
        // Статусы "Ожидает поставки" или "Отмена"
        await axios.post(GAS_WEB_APP_URL, {
          message_id: row,
          status,
          executor: `@${username}`,
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `🔄 Статус заявки #${row} обновлён: ${status}`,
          reply_to_message_id: messageId,
        });
      }
    }

    return res.sendStatus(200);
  }

  // === 📤 Новое сообщение
  if (body.message) {
    const msg = body.message;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const state = userStates.get(chatId);

    if (!state) return res.sendStatus(200);

    if (msg.photo && state.step === 'awaiting_photo') {
      const fileId = msg.photo[msg.photo.length - 1].file_id;

      // Получаем ссылку на файл
      const { data: fileData } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileData.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      const photoLink = fileUrl; // можно сохранить как есть

      state.photo = photoLink;
      state.step = 'awaiting_sum';

      userStates.set(chatId, state);

      const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '💰 Введите сумму выполненных работ:',
      });
      deleteMessageLater(chatId, m.data.result.message_id);

    } else if (state.step === 'awaiting_sum' && msg.text) {
      state.sum = msg.text;
      state.step = 'awaiting_comment';

      userStates.set(chatId, state);

      const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '📝 Введите комментарий:',
      });
      deleteMessageLater(chatId, m.data.result.message_id);

    } else if (state.step === 'awaiting_comment' && msg.text) {
      state.comment = msg.text;

      // Отправляем все данные на GAS
      await axios.post(GAS_WEB_APP_URL, {
        message_id: state.row,
        status: 'Выполнено',
        photo: state.photo,
        sum: state.sum,
        comment: state.comment,
        executor: `@${state.username}`,
      });

      // Обновляем исходное сообщение
      const statusText = `📌 Заявка #${state.row} закрыта.\n📎 Фото: [ссылка](${state.photo})\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: @${state.username}\n✅ Статус: Выполнено`;
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: state.messageId,
        text: statusText,
        parse_mode: 'Markdown',
      });

      const m = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `✅ Заявка #${state.row} успешно закрыта.`,
      });
      deleteMessageLater(chatId, m.data.result.message_id);

      userStates.delete(chatId);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// --- Проверка запуска
app.get('/', (_, res) => res.send('Telegram bot is running.'));

// --- Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server is running on port ${PORT}`);
});

