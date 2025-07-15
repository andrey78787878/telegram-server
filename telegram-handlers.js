module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
  const DELAY_BEFORE_DELETE = 15000;

  // Улучшенное логирование
  function logEvent(event, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${event}:`, JSON.stringify(details, null, 2));
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function buildExecutorButtons(row) {
    const buttons = {
      inline_keyboard: EXECUTORS.map(ex => [
        { text: ex, callback_data: `select_executor:${row}:${ex}` }
      ])
    };
    logEvent('Executor buttons created', { row, buttons });
    return buttons;
  }

  function buildDelayedButtons(row) {
    const buttons = {
      inline_keyboard: [
        [
          { text: '✅ Выполнено', callback_data: `done:${row}` },
          { text: '❌ Отмена', callback_data: `cancelled:${row}` }
        ]
      ]
    };
    logEvent('Delayed buttons created', { row, buttons });
    return buttons;
  }

  async function sendMessage(chatId, text, options = {}) {
    try {
      logEvent('Sending message', { chatId, text, options });
      const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      });
      logEvent('Message sent', { messageId: res.data.result.message_id });
      return res.data.result.message_id;
    } catch (error) {
      logEvent('Message send error', { error: error.message, response: error.response?.data });
      return null;
    }
  }

  async function editMessageText(chatId, messageId, text, reply_markup) {
    try {
      logEvent('Editing message', { chatId, messageId, text, reply_markup });
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...(reply_markup && { reply_markup })
      });
      logEvent('Message edited successfully');
    } catch (error) {
      logEvent('Message edit error', { 
        error: error.message, 
        response: error.response?.data,
        stack: error.stack 
      });
    }
  }

  async function deleteMessageWithDelay(chatId, msgId) {
    try {
      logEvent('Scheduling message deletion', { chatId, msgId, delay: DELAY_BEFORE_DELETE });
      await delay(DELAY_BEFORE_DELETE);
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
      logEvent('Message deleted');
    } catch (e) {
      logEvent('Message deletion failed', { error: e.message });
    }
  }

  app.post('/webhook', async (req, res) => {
    try {
      logEvent('Webhook received', { body: req.body });
      res.sendStatus(200);

      if (req.body.callback_query) {
        const { data: raw, message, from, id: callbackId } = req.body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        logEvent('Callback query received', { 
          rawData: raw,
          chatId,
          messageId,
          from: from.id
        });

        // Ответ на callback query
        try {
          await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { 
            callback_query_id: callbackId 
          });
          logEvent('Callback query answered');
        } catch (e) {
          logEvent('Callback answer failed', { error: e.message });
        }

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        logEvent('Processing callback action', { action, row, executor });

        if (action === 'select_executor') {
          logEvent('Select executor action', { row, executor });
          
          if (!userStates[chatId]) {
            userStates[chatId] = {};
            logEvent('New user state created', { chatId });
          }

          if (executor === 'Текстовой подрядчик') {
            logEvent('Manual executor selected');
            userStates[chatId].awaiting_manual_executor = true;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            return;
          }

          logEvent('Fetching original message data');
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) {
            logEvent('Original message not found', { row });
            return;
          }

          logEvent('Updating request status in Google Sheets');
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

          logEvent('Updating message with new buttons');
          await editMessageText(chatId, originalMessageId, updatedText, buttons);
          
          userStates[chatId] = {
            executor,
            row,
            sourceMessageId: originalMessageId,
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };
          logEvent('User state updated', { state: userStates[chatId] });
        }
        else if (action === 'delayed') {
          logEvent('Delayed action', { row });
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'delayed', 
            row,
            status: 'Ожидает поставки'
          });
          
          const buttons = buildDelayedButtons(row);
          const updatedText = `${message.text}\n\n⏳ Ожидает поставки`;
          await editMessageText(chatId, messageId, updatedText, buttons);
        }
        else if (action === 'done') {
          logEvent('Done action', { row });
          if (userStates[chatId]?.stage === 'awaiting_photo') return;

          const originalIdRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getMessageId',
            row
          });
          const originalMessageId = originalIdRes.data?.message_id;

          if (!originalMessageId) {
            logEvent('Original message not found for done action', { row });
            return;
          }

          userStates[chatId] = {
            row,
            stage: 'awaiting_photo',
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };
          logEvent('Awaiting photo state set');

          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения:');
          userStates[chatId].serviceMessages = [prompt];
          await editMessageText(chatId, originalMessageId, '📌 Ожидаем фото...');
        }
      }
      else if (req.body.message) {
        const { chat, message_id, text, photo } = req.body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        logEvent('Regular message received', { 
          chatId, 
          messageId: message_id,
          text,
          hasPhoto: !!photo,
          currentState: state 
        });

        if (!state) return;

        if (state.awaiting_manual_executor) {
          logEvent('Processing manual executor input');
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row: state.row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row: state.row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) {
            logEvent('Original message not found for manual executor', { row: state.row });
            return;
          }

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
          logEvent('Processing photo for request completion');
          await handlePhoto(chatId, photo, message_id, state);
        }
        else if (state.stage === 'awaiting_amount') {
          logEvent('Processing amount input');
          state.amount = text;
          state.userResponses = [message_id];
          
          const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
          state.serviceMessages = [prompt];
          state.stage = 'awaiting_comment';
        }
        else if (state.stage === 'awaiting_comment') {
          logEvent('Processing final comment');
          await completeRequest(chatId, text, message_id, state);
        }
      }
    } catch (err) {
      logEvent('Webhook processing error', { 
        error: err.message, 
        stack: err.stack,
        requestBody: req.body 
      });
    }
  });

  // Остальные функции (handlePhoto, completeRequest и т.д.) с аналогичным логированием
  async function handlePhoto(chatId, photo, messageId, state) {
    try {
      logEvent('Handling photo', { chatId, messageId });
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length - 1].file_id}`);
      const filePath = fileRes.data.result.file_path;
      state.photoUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      
      state.userResponses = [messageId];
      logEvent('Photo processed', { photoUrl: state.photoUrl });

      const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
      state.serviceMessages = [prompt];
      state.stage = 'awaiting_amount';
      
    } catch (error) {
      logEvent('Photo handling error', { error: error.message });
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото. Попробуйте еще раз.');
    }
  }

  async function completeRequest(chatId, text, messageId, state) {
    try {
      logEvent('Completing request', { chatId, state });
      state.comment = text;
      state.userResponses.push(messageId);

      const originalTextRes = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row: state.row
      });
      
      const originalText = originalTextRes.data?.text || '';
      
      const updatedText = `✅ Выполнено
👷 Исполнитель: ${state.executor}
💰 Сумма: ${state.amount}
📸 Фото: ${state.photoUrl}
📝 Комментарий: ${state.comment || 'не указан'}

━━━━━━━━━━━━

${originalText}`;

      const gasResponse = await axios.post(GAS_WEB_APP_URL, {
        action: 'complete',
        row: state.row,
        photoUrl: state.photoUrl,
        status: 'Выполнено',
        amount: state.amount,
        comment: state.comment,
        message_id: state.originalMessageId
      });

      logEvent('Google Sheets updated', { response: gasResponse.data });

      await editMessageText(chatId, state.originalMessageId, updatedText);
      await cleanupMessages(chatId, state);
      delete userStates[chatId];
      logEvent('Request completed successfully');
      
    } catch (error) {
      logEvent('Request completion error', { error: error.message });
      await sendMessage(chatId, '⚠️ Ошибка при завершении заявки. Попробуйте еще раз.');
    }
  }
};
