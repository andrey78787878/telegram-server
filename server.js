require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 10000;

// Список исполнителей
const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];

const userStates = {}; // Хранение состояния пользователя
const LOG = (...args) => console.log('[LOG]', ...args);

// Endpoint от Telegram
app.post('/webhook', async (req, res) => {
  const body = req.body;
  LOG('📩 Запрос от Telegram:', JSON.stringify(body));

  try {
    if (body.callback_query) {
      const { message, data, from } = body.callback_query;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const username = from.username || from.first_name;

      if (data === 'accept') {
        // Показываем кнопки с исполнителями
        const keyboard = EXECUTORS.map((name) => [{ text: name, callback_data: `executor_${name}` }]);
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: keyboard },
        });
      } else if (data.startsWith('executor_')) {
        const executor = data.replace('executor_', '');
        const row = message.reply_to_message?.message_id || message.message_id;
        LOG('✅ Исполнитель выбран:', executor, 'для строки:', row);

        // Обновление таблицы через GAS
        await axios.post(GAS_WEB_APP_URL, {
          action: 'set_executor', row, executor, status: 'В работе'
        });

        // Обновляем сообщение заявки
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: `✅ Заявка #${row} принята в работу\n👤 Исполнитель: ${executor}`,
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Выполнено ✅', callback_data: `done_${row}` },
                { text: 'Ожидает поставки 📦', callback_data: `wait_${row}` },
                { text: 'Отмена ❌', callback_data: `cancel_${row}` },
              ],
            ],
          },
        });
      } else if (data.startsWith('done_')) {
        const row = data.split('_')[1];
        userStates[chatId] = { stage: 'awaiting_photo', row };

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '📷 Пожалуйста, отправьте фото выполненной работы.',
        });
      } else if (data.startsWith('wait_')) {
        const row = data.split('_')[1];
        await axios.post(GAS_WEB_APP_URL, { row, status: 'Ожидает поставки' });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `📦 Заявка #${row} переведена в статус "Ожидает поставки".`,
        });
      } else if (data.startsWith('cancel_')) {
        const row = data.split('_')[1];
        await axios.post(GAS_WEB_APP_URL, { row, status: 'Отменено' });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `❌ Заявка #${row} отменена.`,
        });
      }
    } else if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;

      if (userStates[chatId]?.stage === 'awaiting_photo' && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const fileUrl = `${TELEGRAM_FILE_API}/${fileRes.data.result.file_path}`;

        userStates[chatId].photoUrl = fileUrl;
        userStates[chatId].stage = 'awaiting_sum';

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '💰 Укажите сумму выполненных работ (в сумах):',
        });
      } else if (userStates[chatId]?.stage === 'awaiting_sum' && msg.text) {
        userStates[chatId].sum = msg.text;
        userStates[chatId].stage = 'awaiting_comment';

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '💬 Добавьте комментарий к заявке:',
        });
      } else if (userStates[chatId]?.stage === 'awaiting_comment' && msg.text) {
        userStates[chatId].comment = msg.text;
        const { row, photoUrl, sum, comment } = userStates[chatId];

        await axios.post(GAS_WEB_APP_URL, {
          row,
          status: 'Выполнено',
          photo: photoUrl,
          sum,
          comment,
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Заявка #${row} закрыта.\n📷 Фото: [ссылка](${photoUrl})\n💰 Сумма: ${sum}\n💬 Комментарий: ${comment}`,
          parse_mode: 'Markdown',
        });

        delete userStates[chatId];
      }
    }
  } catch (err) {
    console.error('[Webhook Error]:', err.response?.data || err.message);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  LOG(`🚀 Сервер запущен на порту ${PORT}`);
  LOG(`GAS_WEB_APP_URL: ${GAS_WEB_APP_URL}`);
});
