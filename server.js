require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwYycNWHJanlUL-vDM6KptXod9GdbzcVa6HI67ttSfRkIPkSYuDQdiEzGCDkRHSKkLV/exec';
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function log(...args) {
  console.log('[LOG]', ...args);
}

const userStates = {}; // состояние пользователя для фото/сумма/комментарий

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
      } else if (userStates[chatId]?.stage === 'awaiting_photo' && body.message.photo) {
        const fileId = body.message.photo.at(-1).file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileRes.data.result.file_path}`;

        userStates[chatId].photoUrl = fileUrl;
        userStates[chatId].stage = 'awaiting_sum';

        await sendMessage(chatId, '💰 Укажите сумму выполненных работ (в сумах):');
      } else if (userStates[chatId]?.stage === 'awaiting_sum' && text) {
        userStates[chatId].sum = text;
        userStates[chatId].stage = 'awaiting_comment';

        await sendMessage(chatId, '💬 Добавьте комментарий к заявке:');
      } else if (userStates[chatId]?.stage === 'awaiting_comment' && text) {
        const { row, photoUrl, sum } = userStates[chatId];
        const comment = text;

        await axios.post(GAS_WEB_APP_URL, {
          row,
          status: 'Выполнено',
          photo: photoUrl,
          sum,
          comment
        });

        await sendMessage(chatId, `✅ Заявка #${row} закрыта.\n📷 <a href="${photoUrl}">Фото</a>\n💰 Сумма: ${sum}\n💬 Комментарий: ${comment}`);
        delete userStates[chatId];
      }
    }

    if (body.callback_query) {
      const query = body.callback_query;
      const data = query.data;
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;

      log('Callback data:', data);

      if (data.startsWith('accept_')) {
        const row = data.split('_')[1];
        const keyboard = EXECUTORS.map((name) => [{ text: name, callback_data: `executor_${row}_${name}` }]);
        await editMessageText(chatId, messageId, 'Выберите исполнителя:', keyboard);
      }

      if (data.startsWith('executor_')) {
        const [, row, ...executorArr] = data.split('_');
        const executor = executorArr.join('_');

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

      if (data.startsWith('done_')) {
        const row = data.split('_')[1];
        userStates[chatId] = { stage: 'awaiting_photo', row };
        await sendMessage(chatId, '📷 Пожалуйста, отправьте фото выполненной работы.');
      }

      if (data.startsWith('wait_')) {
        const row = data.split('_')[1];
        await axios.post(GAS_WEB_APP_URL, { row, status: 'Ожидает поставки' });
        await sendMessage(chatId, `📦 Заявка #${row} переведена в статус "Ожидает поставки".`);
      }

      if (data.startsWith('cancel_')) {
        const row = data.split('_')[1];
        await axios.post(GAS_WEB_APP_URL, { row, status: 'Отменено' });
        await sendMessage(chatId, `❌ Заявка #${row} отменена.`);
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
