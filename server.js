const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_URL = process.env.GAS_WEB_APP_URL;

const buildInitialButtons = (messageId) => ({
  inline_keyboard: [[
    {
      text: 'Принято в работу',
      callback_data: `in_progress_${messageId}`,
    },
  ]],
});

const buildWorkButtons = (messageId) => ({
  inline_keyboard: [[
    { text: '✅ Выполнено', callback_data: `executor_${messageId}` },
    { text: '📦 Ожидает поставки', callback_data: `wait_${messageId}` },
    { text: '❌ Отмена', callback_data: `cancel_${messageId}` },
  ]],
});

const sendMessage = async (chatId, text, markup = null, replyTo = null) => {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (markup) payload.reply_markup = markup;
  if (replyTo) payload.reply_to_message_id = replyTo;

  await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
};

app.post('/webhook', async (req, res) => {
  const body = req.body;

  console.log('📥 Webhook received:', JSON.stringify(body, null, 2));

  const cb = body.callback_query;

  try {
    if (cb) {
      const data = cb.data;
      const chatId = cb.message.chat.id;
      const user = cb.from.username || cb.from.first_name || 'неизвестный';
      const messageId = cb.message.message_id;
      const replyToMessageId = cb.message.reply_to_message?.message_id;
      const targetMessageId = replyToMessageId || messageId;

      console.log(`👉 Callback data: ${data}`);
      console.log(`🔍 Chat ID: ${chatId}, User: ${user}, Msg ID: ${messageId}, Target ID: ${targetMessageId}`);

      const id = Number(data.split('_')[1]); // message_id заявки

      if (data.startsWith('in_progress_')) {
        console.log('🛠 Обработка: Принято в работу');

        await axios.post(GAS_URL, {
          message_id: id,
          status: 'В работе',
          executor: `@${user}`,
        });

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: targetMessageId,
          reply_markup: buildWorkButtons(id),
        });

        await sendMessage(chatId, `👤 Заявка #${id} принята в работу: @${user}`, null, targetMessageId);
      }

      else if (data.startsWith('executor_')) {
        console.log('✅ Обработка: Выполнено');

        await axios.post(GAS_URL, {
          message_id: id,
          status: 'Выполнено',
          step: 'start',
          executor: `@${user}`,
        });

        await sendMessage(chatId, 'Пожалуйста, загрузите фото выполненных работ 📷', null, targetMessageId);
      }

      else if (data.startsWith('wait_')) {
        console.log('📦 Обработка: Ожидает поставки');

        await axios.post(GAS_URL, {
          message_id: id,
          status: 'Ожидает поставки',
        });

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: targetMessageId,
          text: `📦 Заявка #${id} переведена в статус: <b>Ожидает поставки</b>\n👤 @${user}`,
          parse_mode: 'HTML',
        });
      }

      else if (data.startsWith('cancel_')) {
        console.log('❌ Обработка: Отмена');

        await axios.post(GAS_URL, {
          message_id: id,
          status: 'Отмена',
        });

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: targetMessageId,
          text: `❌ Заявка #${id} отменена\n👤 @${user}`,
          parse_mode: 'HTML',
        });
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Ошибка Webhook:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
