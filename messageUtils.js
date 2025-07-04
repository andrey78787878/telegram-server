const { TELEGRAM_API } = require('./config');
const axios = require('axios');

function buildInitialButtons(messageId) {
  return {
    inline_keyboard: [
      [
        {
          text: 'Принято в работу',
          callback_data: JSON.stringify({ action: 'in_progress', messageId }),
        },
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

async function editInlineKeyboard(chatId, messageId, keyboard) {
  try {
    return await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: JSON.stringify(keyboard),
    });
  } catch (error) {
    console.error('Ошибка editInlineKeyboard:', error.response?.data || error.message);
    throw error;
  }
}

async function editMessageText(chatId, messageId, text, keyboard) {
  try {
    return await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: JSON.stringify(keyboard),
    });
  } catch (error) {
    console.error('Ошибка editMessageText:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  buildInitialButtons,
  buildFollowUpButtons,
  editInlineKeyboard,
  editMessageText,
};
