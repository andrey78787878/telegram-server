const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwlJy3XL7EF7rcou2fe7O4uC2cVlmeYfM87D-M6ji4KyU0Ds0sp_SiOuT643vIhCwps/exec';

const sendTelegramMessage = async (chatId, text, options = {}) => {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options
  });
};

const editTelegramMessage = async (chatId, messageId, text, options = {}) => {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options
  });
};

const deleteTelegramMessage = async (chatId, messageId) => {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId
  });
};

const sendToGAS = async (data) => {
  try {
    await axios.post(GAS_URL, data);
  } catch (err) {
    console.error('Ошибка отправки в GAS:', err.message);
  }
};

const handleStatusChange = async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const status = callbackQuery.data;
  const username = callbackQuery.from.username || '';
  const executor = `@${username}`;

  const originalText = callbackQuery.message.text;
  const numberMatch = originalText.match(/#?(\d+)/);
  const requestNumber = numberMatch ? numberMatch[1] : null;

  if (!requestNumber) {
    console.error('Не найден номер заявки в тексте сообщения.');
    return;
  }

  if (status === 'start_work') {
    // Обновляем исходное сообщение
    const newText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;

    await editTelegramMessage(chatId, messageId, newText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Выполнено ✅', callback_data: 'done' },
            { text: 'Ожидает поставки 📦', callback_data: 'awaiting' },
            { text: 'Отмена ❌', callback_data: 'cancel' }
          ]
        ]
      }
    });

    await sendToGAS({
      message_id: messageId,
      status: 'В работе',
      username,
      row: requestNumber
    });
  }

  if (['done', 'awaiting', 'cancel'].includes(status)) {
    // Обработка следующих шагов — делается в других файлах
    // Здесь можно опционально отредактировать кнопки как неактивные
    await editTelegramMessage(chatId, messageId, originalText, {
      reply_markup: {
        inline_keyboard: []
      }
    });

    await sendTelegramMessage(chatId, `Выбран статус: ${status === 'done' ? 'Выполнено' : status === 'awaiting' ? 'Ожидает поставки' : 'Отмена'}`, {
      reply_to_message_id: messageId
    });
  }
};

module.exports = {
  sendTelegramMessage,
  editTelegramMessage,
  deleteTelegramMessage,
  sendToGAS,
  handleStatusChange
};
