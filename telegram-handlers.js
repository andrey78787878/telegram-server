// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
  const DELAY_BEFORE_DELETE = 15000; // 15 секунд задержки

  // Функция с задержкой
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Создание кнопок исполнителей
  function buildExecutorButtons(row) {
    return {
      inline_keyboard: EXECUTORS.map(ex => [
        { text: ex, callback_data: `select_executor:${row}:${ex}` }
      ])
    };
  }

  // Кнопки для статуса "Ожидает поставки"
  function buildDelayedButtons(row) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Выполнено', callback_data: `done:${row}` },
          { text: '❌ Отмена', callback_data: `cancelled:${row}` }
        ]
      ]
    };
  }

  async function sendMessage(chatId, text, options = {}) {
    try {
      const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      });
      return res.data.result.message_id;
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error.message);
      return null;
    }
  }

  async function editMessageText(chatId, messageId, text, reply_markup) {
    try {
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...(reply_markup && { reply_markup })
      });
    } catch (error) {
      console.error('Ошибка изменения сообщения:', error.message);
    }
  }

  async function deleteMessageWithDelay(chatId, msgId) {
    try {
      await delay(DELAY_BEFORE_DELETE);
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
    } catch (e) {
      console.warn('Не удалось удалить сообщение:', e.message);
    }
  }

  async function cleanupMessages(chatId, state) {
    try {
      const messagesToDelete = [
        ...(state.serviceMessages || []),
        ...(state.userResponses || [])
      ];
      
      if (messagesToDelete.length) {
        await Promise.all(messagesToDelete.map(msgId => 
          deleteMessageWithDelay(chatId, msgId)
        ));
      }
    } catch (error) {
      console.error('Ошибка при очистке сообщений:', error);
    }
  }

  // Остальные функции (handlePhoto, handleAmount, completeRequest) остаются без изменений

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      console.log('Incoming webhook:', JSON.stringify(body)); // Логируем входящий запрос

      // Отвечаем сразу, чтобы Telegram не считал запрос неудачным
      res.sendStatus(200);

      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        console.log(`Processing callback: ${raw}`);

        // Отвечаем на callback
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId,
          text: "Обрабатываю...",
          show_alert: false
        }).catch(e => console.error('Callback answer error:', e));

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        if (action === 'in_progress') {
          await editMessageText(chatId, messageId, message.text, { inline_keyboard: [] });
          
          const keyboard = buildExecutorButtons(row);
          const newText = `${message.text}\n\nВыберите исполнителя:`;
          await editMessageText(chatId, messageId, newText, keyboard);

          userStates[chatId] = { 
            row, 
            sourceMessageId: messageId, 
            serviceMessages: [],
            userResponses: []
          };
          return;
        }

        if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = {};

          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            return;
          }

          // Оптимизация: параллельные запросы
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) return;

          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row, 
            executor, 
            message_id: originalMessageId 
          });

          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
          const buttons = {
            inline_keyboard: [
              [
                { text: '✅ Выполнено', callback_data: `done:${row}` },
                { text: '⏳ Ожидает поставки', callback_data: `delayed:${row}` },
                { text: '❌ Отмена', callback_data: `cancelled:${row}` }
              ]
            ]
          };

          await editMessageText(chatId, originalMessageId, updatedText, buttons);
          
          if (originalMessageId !== messageId) {
            await editMessageText(chatId, messageId, message.text);
          }

          userStates[chatId] = {
            executor,
            row,
            sourceMessageId: originalMessageId,
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };
        }
        else if (action === 'done') {
          if (userStates[chatId]?.stage === 'awaiting_photo') return;

          const originalIdRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getMessageId',
            row
          });
          const originalMessageId = originalIdRes.data?.message_id;

          if (!originalMessageId) return;

          userStates[chatId] = {
            row,
            stage: 'awaiting_photo',
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };

          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения:');
          userStates[chatId].serviceMessages = [prompt];
          await editMessageText(chatId, originalMessageId, '📌 Ожидаем фото...');
        }
        else if (action === 'delayed') {
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'delayed', 
            row,
            status: 'Ожидает поставки'
          });
          
          const buttons = buildDelayedButtons(row);
          const updatedText = `${message.text}\n\n⏳ Ожидает поставки`;
          await editMessageText(chatId, messageId, updatedText, buttons);
        }
      }
      else if (body.message) {
        const { chat, message_id, text, photo } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        if (!state) return;

        if (state.awaiting_manual_executor) {
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row: state.row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row: state.row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) return;

          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row: state.row, 
            executor: text, 
            message_id: originalMessageId 
          });

          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${text}`;
          const buttons = {
            inline_keyboard: [
              [
                { text: '✅ Выполнено', callback_data: `done:${state.row}` },
                { text: '⏳ Ожидает поставки', callback_data: `delayed:${state.row}` },
                { text: '❌ Отмена', callback_data: `cancelled:${state.row}` }
              ]
            ]
          };

          await editMessageText(chatId, originalMessageId, updatedText, buttons);
          await cleanupMessages(chatId, state);

          userStates[chatId] = {
            ...state,
            executor: text,
            sourceMessageId: originalMessageId,
            originalMessageId,
            awaiting_manual_executor: false
          };
        }
        else if (state.stage === 'awaiting_photo' && photo) {
          await handlePhoto(chatId, photo, message_id, state);
        }
        else if (state.stage === 'awaiting_amount') {
          state.amount = text;
          state.userResponses = [message_id];
          
          const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
          state.serviceMessages = [prompt];
          state.stage = 'awaiting_comment';
        }
        else if (state.stage === 'awaiting_comment') {
          await completeRequest(chatId, text, message_id, state);
        }
      }
    } catch (err) {
      console.error('Webhook error:', err);
    }
  });
};
