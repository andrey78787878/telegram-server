const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const { BOT_TOKEN, TELEGRAM_API, GAS_URL } = require('./config');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// ==== КНОПКИ ====

function buildInitialButtons(messageId) {
  return {
    inline_keyboard: [
      [
        {
          text: 'Принято в работу',
          callback_data: JSON.stringify({ action: 'choose_executor', messageId }),
        },
      ],
    ],
  };
}

function buildExecutorButtons(messageId) {
  return {
    inline_keyboard: [
      [
        { text: '@EvelinaB87', callback_data: JSON.stringify({ action: 'set_executor', executor: '@EvelinaB87', messageId }) },
        { text: '@Olim19', callback_data: JSON.stringify({ action: 'set_executor', executor: '@Olim19', messageId }) },
      ],
      [
        { text: '@Oblayor_04_09', callback_data: JSON.stringify({ action: 'set_executor', executor: '@Oblayor_04_09', messageId }) },
        { text: 'Подрядчик', callback_data: JSON.stringify({ action: 'set_executor', executor: 'Подрядчик', messageId }) },
      ],
    ],
  };
}

function buildFollowUpButtons(messageId) {
  return {
    inline_keyboard: [
      [
        { text: 'Выполнено ✅', callback_data: JSON.stringify({ action: 'completed', messageId }) },
        { text: 'Ожидает поставки ⏳', callback_data: JSON.stringify({ action: 'delayed', messageId }) },
        { text: 'Отмена ❌', callback_data: JSON.stringify({ action: 'cancelled', messageId }) },
      ],
    ],
  };
}

// ==== ОБРАБОТКА callback_query ====

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { data, message, id: callbackQueryId } = body.callback_query;
    const { chat, message_id } = message;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      console.error('Ошибка разбора callback_data:', err);
      return res.sendStatus(200);
    }

    const { action, messageId, executor } = parsed;

    try {
      if (action === 'choose_executor') {
        // показать список исполнителей
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chat.id,
          text: 'Выберите исполнителя:',
          reply_markup: JSON.stringify(buildExecutorButtons(messageId)),
        });
      }

      if (action === 'set_executor') {
        // обновить кнопки и записать исполнителя
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chat.id,
          message_id: messageId,
          reply_markup: JSON.stringify(buildFollowUpButtons(messageId)),
        });

        // записать в таблицу исполнителя
        await axios.post(GAS_URL, {
          message_id: messageId,
          executor,
        });

        // уведомление об исполнителе
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chat.id,
          text: `👤 Исполнитель выбран: ${executor}`,
          reply_to_message_id: messageId,
        });

        // удалить сообщение выбора исполнителя
        await axios.post(`${TELEGRAM_API}/deleteMessage`, {
          chat_id: chat.id,
          message_id: message.message_id,
        });
      }

      // можно добавить обработку completed / delayed / cancelled

    } catch (error) {
      console.error('Ошибка при обработке callback:', error.response?.data || error.message);
    }

    // Ответ Telegram
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// ==== ЗАПУСК ====

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

