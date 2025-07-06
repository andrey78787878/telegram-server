const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { BOT_TOKEN, GAS_WEB_APP_URL } = require('./config');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

  const res = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  console.log('📩 Отправлено сообщение:', res.data);
};

app.post('/webhook', async (req, res) => {
  const body = req.body;
  const cb = body.callback_query;

  try {
    if (cb) {
      const data = cb.data;
      const chatId = cb.message.chat.id;
      const user = cb.from.username || cb.from.first_name || 'неизвестный';

      const messageId = cb.message.message_id;
      const replyToMessageId = cb.message.reply_to_message?.message_id;
      const targetMessageId = replyToMessageId || messageId;

      const id = Number(data.split('_')[1]); // message_id исходной заявки

      console.log('👉 Кнопка нажата:', data, '| Пользователь:', user, '| Исходный message_id:', id);

      if (data.startsWith('in_progress_')) {
        await axios.post(GAS_WEB_APP_URL, {
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
        await axios.post(GAS_WEB_APP_URL, {
          message_id: id,
          status: 'Выполнено',
          step: 'start',
          executor: `@${user}`,
        });

        await sendMessage(chatId, 'Пожалуйста, загрузите фото выполненных работ 📷', null, targetMessageId);
      }

      else if (data.startsWith('wait_')) {
        await axios.post(GAS_WEB_APP_URL, {
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
        await axios.post(GAS_WEB_APP_URL, {
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

    console.log('⚠️ Нет callback_query:', JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Ошибка в webhook:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
