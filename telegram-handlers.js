// telegram-bot-server.js
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

// Инициализация приложения
const app = express();
app.use(bodyParser.json());

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Состояния пользователей
const userStates = {};

// Константы
const STATUSES = {
  PENDING: 'в очереди',
  IN_PROGRESS: 'В работе',
  COMPLETED: 'Выполнено',
  DELAYED: 'Ожидает поставки',
  CANCELLED: 'Отменено'
};

const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

// Утилиты
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Клавиатуры
const Keyboards = {
  executors: (row) => ({
    inline_keyboard: EXECUTORS.map(executor => [{
      text: executor,
      callback_data: `select_executor:${row}:${encodeURIComponent(executor)}`
    }])
  }),

  actionButtons: (row) => ({
    inline_keyboard: [
      [
        { text: '✅ Выполнено', callback_data: `complete:${row}` },
        { text: '⏳ Ожидает поставки', callback_data: `delay:${row}` }
      ],
      [
        { text: '❌ Отменить', callback_data: `cancel:${row}` }
      ]
    ]
  }),

  delayedButtons: (row) => ({
    inline_keyboard: [
      [
        { text: '✅ Выполнено', callback_data: `complete:${row}` },
        { text: '❌ Отменить', callback_data: `cancel:${row}` }
      ]
    ]
  })
};

// Telegram API методы
const TelegramAPI = {
  sendMessage: async (chatId, text, options = {}) => {
    try {
      const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      });
      return res.data.result;
    } catch (error) {
      console.error('Send message error:', error.response?.data || error.message);
      return null;
    }
  },

  editMessageText: async (chatId, messageId, text, markup) => {
    try {
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: markup
      });
    } catch (error) {
      console.error('Edit message error:', error.response?.data || error.message);
    }
  },

  answerCallback: async (callbackId, text) => {
    try {
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text
      });
    } catch (error) {
      console.error('Answer callback error:', error.response?.data || error.message);
    }
  }
};

// GAS API методы
const GasAPI = {
  getRequestInfo: async (row) => {
    try {
      const res = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestInfo',
        row
      });
      return res.data;
    } catch (error) {
      console.error('GAS request error:', error.response?.data || error.message);
      return null;
    }
  },

  updateStatus: async (row, status, executor = null) => {
    try {
      await axios.post(GAS_WEB_APP_URL, {
        action: 'updateStatus',
        row,
        status,
        ...(executor && { executor })
      });
      return true;
    } catch (error) {
      console.error('GAS update error:', error.response?.data || error.message);
      return false;
    }
  },

  completeRequest: async (row, data) => {
    try {
      await axios.post(GAS_WEB_APP_URL, {
        action: 'complete',
        row,
        ...data
      });
      return true;
    } catch (error) {
      console.error('GAS complete error:', error.response?.data || error.message);
      return false;
    }
  }
};

// Обработчики состояний
const StateHandlers = {
  handleExecutorSelection: async (chatId, row, executor, messageId) => {
    const decodedExecutor = decodeURIComponent(executor);
    
    // Обновляем статус в таблице
    const success = await GasAPI.updateStatus(row, STATUSES.IN_PROGRESS, decodedExecutor);
    if (!success) return false;

    // Получаем текущий текст заявки
    const requestInfo = await GasAPI.getRequestInfo(row);
    if (!requestInfo) return false;

    // Формируем обновленное сообщение
    const updatedText = `${requestInfo.text}\n\n🟢 ${STATUSES.IN_PROGRESS}\n👷 Исполнитель: ${decodedExecutor}`;

    // Обновляем сообщение в чате
    await TelegramAPI.editMessageText(
      chatId,
      messageId,
      updatedText,
      Keyboards.actionButtons(row)
    );

    // Сохраняем состояние
    userStates[chatId] = {
      row,
      executor: decodedExecutor,
      originalMessageId: messageId,
      stage: 'awaiting_action'
    };

    return true;
  },

  handleComplete: async (chatId, row, messageId) => {
    // Обновляем состояние
    userStates[chatId] = {
      row,
      originalMessageId: messageId,
      stage: 'awaiting_photo'
    };

    // Запрашиваем фото
    await TelegramAPI.sendMessage(
      chatId,
      '📸 Пришлите фото выполненной работы:',
      { reply_to_message_id: messageId }
    );

    return true;
  },

  handlePhoto: async (chatId, photo, messageId) => {
    const state = userStates[chatId];
    if (!state || state.stage !== 'awaiting_photo') return false;

    // Сохраняем ссылку на фото
    state.photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${photo.file_path}`;
    state.stage = 'awaiting_amount';

    // Запрашиваем сумму
    await TelegramAPI.sendMessage(
      chatId,
      '💰 Введите сумму выполненной работы:',
      { reply_to_message_id: state.originalMessageId }
    );

    return true;
  },

  handleAmount: async (chatId, amount, messageId) => {
    const state = userStates[chatId];
    if (!state || state.stage !== 'awaiting_amount') return false;

    state.amount = amount;
    state.stage = 'awaiting_comment';

    // Запрашиваем комментарий
    await TelegramAPI.sendMessage(
      chatId,
      '📝 Введите комментарий к работе:',
      { reply_to_message_id: state.originalMessageId }
    );

    return true;
  },

  finalizeCompletion: async (chatId, comment, messageId) => {
    const state = userStates[chatId];
    if (!state || state.stage !== 'awaiting_comment') return false;

    // Получаем информацию о заявке
    const requestInfo = await GasAPI.getRequestInfo(state.row);
    if (!requestInfo) return false;

    // Обновляем данные в таблице
    const completionData = {
      photoUrl: state.photoUrl,
      amount: state.amount,
      comment,
      status: STATUSES.COMPLETED
    };

    const success = await GasAPI.completeRequest(state.row, completionData);
    if (!success) return false;

    // Формируем финальное сообщение
    const completedText = `✅ ${STATUSES.COMPLETED}\n\n` +
      `👷 Исполнитель: ${state.executor}\n` +
      `💰 Сумма: ${state.amount}\n` +
      `📸 Фото: ${state.photoUrl ? 'приложено' : 'отсутствует'}\n` +
      `📝 Комментарий: ${comment || 'не указан'}\n\n` +
      `━━━━━━━━━━━━\n${requestInfo.text}`;

    // Обновляем сообщение
    await TelegramAPI.editMessageText(
      chatId,
      state.originalMessageId,
      completedText
    );

    // Очищаем состояние
    delete userStates[chatId];

    return true;
  }
};

// Webhook обработчик
app.post('/webhook', async (req, res) => {
  try {
    const { body } = req;
    console.log('Incoming update:', JSON.stringify(body, null, 2));

    // Быстрый ответ Telegram
    res.sendStatus(200);

    if (body.callback_query) {
      await handleCallback(body.callback_query);
    } else if (body.message) {
      await handleMessage(body.message);
    }
  } catch (error) {
    console.error('Webhook error:', error.stack);
  }
});

// Обработка callback-запросов
async function handleCallback(callback) {
  const { data, message, id: callbackId } = callback;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  console.log(`Processing callback: ${data}`);

  // Подтверждаем получение callback
  await TelegramAPI.answerCallback(callbackId, 'Обработка...');

  const [action, row, ...params] = data.split(':');

  switch (action) {
    case 'select_executor':
      const executor = params[0];
      await StateHandlers.handleExecutorSelection(chatId, row, executor, messageId);
      break;

    case 'complete':
      await StateHandlers.handleComplete(chatId, row, messageId);
      break;

    case 'delay':
      await GasAPI.updateStatus(row, STATUSES.DELAYED);
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        `${message.text}\n\n⏳ ${STATUSES.DELAYED}`,
        Keyboards.delayedButtons(row)
      );
      break;

    case 'cancel':
      await GasAPI.updateStatus(row, STATUSES.CANCELLED);
      await TelegramAPI.editMessageText(
        chatId,
        messageId,
        `${message.text}\n\n❌ ${STATUSES.CANCELLED}`
      );
      break;

    default:
      console.warn(`Unknown callback action: ${action}`);
  }
}

// Обработка сообщений
async function handleMessage(message) {
  const { chat, message_id, text, photo } = message;
  const chatId = chat.id;
  const state = userStates[chatId];

  if (!state) return;

  // Обработка фото
  if (photo && state.stage === 'awaiting_photo') {
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length-1].file_id}`);
    await StateHandlers.handlePhoto(chatId, fileRes.data.result, message_id);
    return;
  }

  // Обработка текстовых сообщений
  if (text) {
    switch (state.stage) {
      case 'awaiting_amount':
        await StateHandlers.handleAmount(chatId, text, message_id);
        break;

      case 'awaiting_comment':
        await StateHandlers.finalizeCompletion(chatId, text, message_id);
        break;

      default:
        await TelegramAPI.sendMessage(
          chatId,
          'Пожалуйста, используйте кнопки для управления заявками'
        );
    }
  }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: https://yourdomain.com/webhook`);
  console.log(`GAS URL: ${GAS_WEB_APP_URL}`);
});
