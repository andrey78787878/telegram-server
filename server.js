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
  inline_keyboard: [
    [
      { text: '✅ Выполнено', callback_data: `executor_${messageId}` },
      { text: '📦 Ожидает поставки', callback_data: `wait_${messageId}` },
      { text: '❌ Отмена', callback_data: `cancel_${messageId}` },
    ],
  ],
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
  const cb = body.callback_query;
  const msg = body.message;

  try {
    if (cb) {
      const data = cb.data;
      const chatId = cb.message.chat.id;
      const user = cb.from.username || cb.from.first_name || 'неизвестный';
      const rawId = data.split('_')[1];
      const messageIdNum = Number(rawId);

      // Правильный msgId для редактирования
      const msgId = cb.message.reply_to_message?.message_id || cb.message.message_id;

      if (data.startsWith('in_progress_')) {
        await axios.post(GAS_URL, {
          message_id: messageIdNum,
          status: 'В работе',
          executor: `@${user}`,
        });

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: buildWorkButtons(messageIdNum),
        });

        await sendMessage(chatId, `👤 Заявка #${messageIdNum} принята в работу: @${user}`, null, messageIdNum);
        return res.sendStatus(200);
      }

      if (data.startsWith('executor_')) {
        await axios.post(GAS_URL, {
          message_id: messageIdNum,
          status: 'Выполнено',
          step: 'start',
          executor: `@${user}`,
        });

        await sendMessage(chatId, 'Пожалуйста, загрузите фото выполненных работ 📷', null, cb.message.message_id);
        return res.sendStatus(200);
      }

      if (data.startsWith('wait_')) {
        await axios.post(GAS_URL, {
          message_id: messageIdNum,
          status: 'Ожидает поставки',
        });

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: msgId,
          text: `📦 Заявка #${messageIdNum} переведена в статус: <b>Ожидает поставки</b>\n👤 @${user}`,
          parse_mode: 'HTML',
        });

        return res.sendStatus(200);
      }

      if (data.startsWith('cancel_')) {
        await axios.post(GAS_URL, {
          message_id: messageIdNum,
          status: 'Отмена',
        });

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: msgId,
          text: `❌ Заявка #${messageIdNum} отменена\n👤 @${user}`,
          parse_mode: 'HTML',
        });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
