// telegram-handlers.js
// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
  const DELAY_BEFORE_DELETE = 15000; // 15 секунд задержки перед удалением

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

  async function handlePhoto(chatId, photo, messageId, state) {
    try {
      // Получаем информацию о файле
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length - 1].file_id}`);
      const filePath = fileRes.data.result.file_path;
      state.photoUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      
      // Сохраняем ID сообщения с фото
      state.userResponses = [messageId];

      // Запрашиваем сумму с задержкой перед удалением
      const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
      state.serviceMessages = [prompt];
      state.stage = 'awaiting_amount';
      
    } catch (error) {
      console.error('Ошибка при обработке фото:', error);
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото. Попробуйте еще раз.');
    }
  }

  async function completeRequest(chatId, text, messageId, state) {
    try {
      state.comment = text;
      state.userResponses.push(messageId);

      // Получаем оригинальный текст заявки
      const originalTextRes = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row: state.row
      });
      
      const originalText = originalTextRes.data?.text || '';
      
      // Формируем обновленный текст
      const updatedText = `✅ Выполнено
👷 Исполнитель: ${state.executor}
💰 Сумма: ${state.amount}
📸 Фото: ${state.photoUrl}
📝 Комментарий: ${state.comment || 'не указан'}

━━━━━━━━━━━━

${originalText}`;

      // Отправка данных в Google Sheets
      const gasResponse = await axios.post(GAS_WEB_APP_URL, {
        action: 'updateAfterCompletion',
        row: state.row,
        photoUrl: state.photoUrl,
        sum: state.amount,
        comment: state.comment,
        executor: state.executor,
        message_id: state.originalMessageId
      });

      console.log('GAS Response:', gasResponse.data);

      if (gasResponse.data.error) {
        throw new Error(gasResponse.data.error);
      }

      await editMessageText(chatId, state.originalMessageId, updatedText);
      await cleanupMessages(chatId, state);
      delete userStates[chatId];
      
    } catch (error) {
      console.error('Ошибка при завершении заявки:', error);
      await sendMessage(chatId, '⚠️ Ошибка при завершении заявки. Попробуйте еще раз.');
    }
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      res.sendStatus(200); // Быстрый ответ серверу Telegram

      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { 
          callback_query_id: callbackId 
        }).catch(console.error);

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = {};

          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            return;
          }

          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) return;

          // Обновляем статус в Google Sheets
          const markResponse = await axios.post(GAS_WEB_APP_URL, { 
            action: 'markInProgress', 
            row, 
            executor, 
            message_id: originalMessageId 
          });

          if (markResponse.data.error) {
            throw new Error(markResponse.data.error);
          }

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
          
          userStates[chatId] = {
            executor,
            row,
            sourceMessageId: originalMessageId,
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };
        }
        else if (action === 'delayed') {
          const markResponse = await axios.post(GAS_WEB_APP_URL, { 
            action: 'markInProgress', 
            row,
            status: 'Ожидает поставки'
          });

          if (markResponse.data.error) {
            throw new Error(markResponse.data.error);
          }
          
          const buttons = buildDelayedButtons(row);
          const updatedText = `${message.text}\n\n⏳ Ожидает поставки`;
          await editMessageText(chatId, messageId, updatedText, buttons);
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
        else if (action === 'cancelled') {
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'markInProgress', 
            row,
            status: 'Отменено'
          });
          const updatedText = `${message.text}\n\n❌ Отменено`;
          await editMessageText(chatId, messageId, updatedText);
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

          // Обновляем статус в Google Sheets
          const markResponse = await axios.post(GAS_WEB_APP_URL, { 
            action: 'markInProgress', 
            row: state.row, 
            executor: text, 
            message_id: originalMessageId 
          });

          if (markResponse.data.error) {
            throw new Error(markResponse.data.error);
          }

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
