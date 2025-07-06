const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyS1vPiaxs488I28pRPcwG_OMVd3eBRX0dqk2tPc8d8HwASxEUXi3mJsps4o-n033-3/exec';

const EXECUTORS = [
  { text: '@EvelinaB87', value: '@EvelinaB87' },
  { text: '@Olim19', value: '@Olim19' },
  { text: '@Oblayor_04_09', value: '@Oblayor_04_09' },
  { text: 'Текстовой подрядчик', value: 'Текстовой подрядчик' }
];

// ===== Utils =====
const sendMessage = async (chatId, text, replyMarkup, replyToMessageId) => {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;

  return axios.post(`${TELEGRAM_API}/sendMessage`, payload);
};

const deleteMessage = async (chatId, messageId) => {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId
  }).catch(() => {});
};

const editMessage = async (chatId, messageId, text, replyMarkup) => {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) payload.reply_markup = JSON.stringify(replyMarkup);

  return axios.post(`${TELEGRAM_API}/editMessageText`, payload);
};

// ===== Обработка Webhook =====
app.post('/', async (req, res) => {
  const body = req.body;

  try {
    // 1. Кнопка "Принято в работу"
    if (body.callback_query) {
      const cb = body.callback_query;
      const data = cb.data;
      const chatId = cb.message.chat.id;
      const messageId = cb.message.message_id;

      if (data.startsWith('start_work_')) {
        const row = data.split('_')[2];

        // Показываем кнопки исполнителей
        const buttons = EXECUTORS.map(exec => [
          { text: exec.text, callback_data: `executor_${exec.value}_${row}_${messageId}` }
        ]);

        const msg = await sendMessage(chatId, 'Выберите исполнителя:', { inline_keyboard: buttons });
        setTimeout(() => deleteMessage(chatId, msg.data.result.message_id), 60000); // удалим через 60 сек
        return res.sendStatus(200);
      }

      // 2. Обработка выбора исполнителя
      if (data.startsWith('executor_')) {
        const [_, executor, row, parentMsgId] = data.split('_');

        // Отправка данных в GAS
        await axios.post(GAS_URL, {
          row,
          executor,
          message_id: parentMsgId,
          status: 'В работе'
        });

        // Удаляем сообщение с кнопками исполнителей
        await deleteMessage(chatId, cb.message.message_id);

        // Обновляем оригинальное сообщение
        const statusText = `🟢 <b>Заявка в работе</b>\n👤 Исполнитель: ${executor}`;
        const followupButtons = {
          inline_keyboard: [
            [{ text: '✅ Выполнено', callback_data: `done_${row}_${executor}_${parentMsgId}` }],
            [{ text: '🕐 Ожидает поставки', callback_data: `waiting_${row}` }],
            [{ text: '❌ Отмена', callback_data: `cancel_${row}` }]
          ]
        };
        await editMessage(chatId, Number(parentMsgId), statusText, followupButtons);
        return res.sendStatus(200);
      }

      // Другие кнопки можно добавить здесь — done_, waiting_, cancel_
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка в webhook:', err.message, err.stack);
    res.sendStatus(500);
  }
});

// ===== Запуск сервера =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
