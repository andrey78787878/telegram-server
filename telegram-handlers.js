const axios = require('axios');

module.exports = (app, userStates) => {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
  const DELAY_BEFORE_DELETE = 15000;

  // ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
  const sendMessage = async (chatId, text, options = {}) => {
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
  };

  const editMessage = async (chatId, messageId, text, replyMarkup) => {
    try {
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
    } catch (error) {
      console.error('Ошибка редактирования сообщения:', error.message);
    }
  };

  const deleteMessage = async (chatId, messageId) => {
    try {
      await new Promise(resolve => setTimeout(resolve, DELAY_BEFORE_DELETE));
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: messageId
      });
    } catch (error) {
      console.warn('Не удалось удалить сообщение:', error.message);
    }
  };

  const cleanupMessages = async (chatId, state) => {
    try {
      const messagesToDelete = [
        ...(state.serviceMessages || []),
        ...(state.userResponses || [])
      ];
      
      await Promise.all(messagesToDelete.map(msgId => 
        deleteMessage(chatId, msgId)
      ));
    } catch (error) {
      console.error('Ошибка при очистке сообщений:', error);
    }
  };

  // ==================== ОСНОВНЫЕ ОБРАБОТЧИКИ ====================
  const handleNewRequest = async (chatId, row) => {
    try {
      const keyboard = {
        inline_keyboard: [
          [{
            text: 'Принять в работу',
            callback_data: `show_executors:${row}`
          }]
        ]
      };
      
      await sendMessage(chatId, `📍 Заявка #${row} готова к обработке`, { reply_markup: keyboard });
    } catch (error) {
      console.error('Ошибка создания новой заявки:', error);
    }
  };

  const showExecutors = async (chatId, messageId, row) => {
    try {
      const keyboard = {
        inline_keyboard: EXECUTORS.map(executor => [
          { text: executor, callback_data: `select_executor:${row}:${executor}` }
        ])
      };
      
      await editMessage(chatId, messageId, 'Выберите исполнителя:', keyboard);
      userStates[chatId] = { row, serviceMessages: [messageId] };
    } catch (error) {
      console.error('Ошибка показа исполнителей:', error);
    }
  };

  const assignExecutor = async (chatId, row, executor, originalMessageId) => {
    try {
      // Обновляем Google Sheets
      const gasResponse = await axios.post(GAS_WEB_APP_URL, {
        action: 'in_progress',
        row,
        executor,
        message_id: originalMessageId
      });

      if (gasResponse.data?.error) throw new Error(gasResponse.data.error);

      // Получаем текст заявки
      const textRes = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row
      });

      const updatedText = `${textRes.data?.text || ''}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
      
      const buttons = {
        inline_keyboard: [
          [
            { text: '✅ Выполнено', callback_data: `done:${row}` },
            { text: '⏳ Ожидает поставки', callback_data: `delayed:${row}` },
            { text: '❌ Отмена', callback_data: `cancelled:${row}` }
          ]
        ]
      };

      await editMessage(chatId, originalMessageId, updatedText, buttons);
      
      // Сохраняем состояние
      userStates[chatId] = {
        executor,
        row,
        originalMessageId,
        stage: 'awaiting_photo',
        serviceMessages: [],
        userResponses: []
      };
    } catch (error) {
      console.error('Ошибка назначения исполнителя:', error);
      await sendMessage(chatId, '⚠️ Ошибка при назначении исполнителя');
    }
  };

  const handlePhoto = async (chatId, photo, messageId) => {
    try {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length-1].file_id}`);
      const photoUrl = `${TELEGRAM_API.replace('/bot', '/file/bot')}/${fileRes.data.result.file_path}`;
      
      userStates[chatId] = {
        ...userStates[chatId],
        photoUrl,
        userResponses: [...(userStates[chatId].userResponses || []), messageId],
        stage: 'awaiting_amount'
      };

      const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
      userStates[chatId].serviceMessages = [prompt];
    } catch (error) {
      console.error('Ошибка обработки фото:', error);
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото');
    }
  };

  const handleAmount = async (chatId, text, messageId) => {
    try {
      userStates[chatId] = {
        ...userStates[chatId],
        amount: text,
        userResponses: [...(userStates[chatId].userResponses || []), messageId],
        stage: 'awaiting_comment'
      };
      
      const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
      userStates[chatId].serviceMessages = [...(userStates[chatId].serviceMessages || []), prompt];
    } catch (error) {
      console.error('Ошибка обработки суммы:', error);
      await sendMessage(chatId, '⚠️ Ошибка. Попробуйте еще раз.');
    }
  };

  const completeRequest = async (chatId, comment, messageId) => {
    try {
      const state = userStates[chatId];
      if (!state) throw new Error('Состояние не найдено');

      // Проверка обязательных данных
      if (!state.executor || !state.row || !state.originalMessageId) {
        throw new Error('Недостаточно данных для завершения заявки');
      }

      // Отправляем данные в Google Sheets
      const gasResponse = await axios.post(GAS_WEB_APP_URL, {
        action: 'complete',
        row: state.row,
        photoUrl: state.photoUrl || '',
        amount: state.amount || '',
        comment: comment || '',
        executor: state.executor,
        message_id: state.originalMessageId
      });

      if (gasResponse.data?.error) throw new Error(gasResponse.data.error);

      // Формируем итоговое сообщение
      const textRes = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row: state.row
      });

      const completedText = `✅ Выполнено\n` +
        `👷 Исполнитель: ${state.executor}\n` +
        `💰 Сумма: ${state.amount || 'не указана'}\n` +
        `📸 Фото: ${state.photoUrl ? 'есть' : 'нет'}\n` +
        `📝 Комментарий: ${comment || 'не указан'}\n\n` +
        `━━━━━━━━━━━━\n\n` +
        (textRes.data?.text || '');

      await editMessage(chatId, state.originalMessageId, completedText);
      await cleanupMessages(chatId, state);
      
      // Очищаем состояние
      delete userStates[chatId];
    } catch (error) {
      console.error('Ошибка завершения заявки:', error);
      await sendMessage(chatId, `⚠️ Ошибка: ${error.message}`);
    }
  };

  // ==================== ОБРАБОТКА ВХОДЯЩИХ СООБЩЕНИЙ ====================
  app.post('/webhook', async (req, res) => {
    try {
      const { body } = req;
      res.sendStatus(200);

      // Обработка callback_query (нажатия кнопок)
      if (body.callback_query) {
        const { data, message, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const [action, row, executor] = data.split(':');

        // Ответ на callback
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId
        });

        switch(action) {
          case 'show_executors':
            await showExecutors(chatId, messageId, row);
            break;

          case 'select_executor':
            if (executor === 'Текстовой подрядчик') {
              userStates[chatId] = { row, awaitingManualExecutor: true };
              await sendMessage(chatId, '✏️ Введите имя подрядчика:');
              break;
            }

            const messageIdRes = await axios.post(GAS_WEB_APP_URL, {
              action: 'getMessageId',
              row
            });

            if (messageIdRes.data?.message_id) {
              await assignExecutor(chatId, row, executor, messageIdRes.data.message_id);
            }
            break;

          case 'done':
            const msgIdRes = await axios.post(GAS_WEB_APP_URL, {
              action: 'getMessageId',
              row
            });

            if (msgIdRes.data?.message_id) {
              userStates[chatId] = {
                row,
                originalMessageId: msgIdRes.data.message_id,
                stage: 'awaiting_photo'
              };
              await sendMessage(chatId, '📸 Пришлите фото выполнения:');
            }
            break;

          case 'delayed':
            await axios.post(GAS_WEB_APP_URL, { action: 'delayed', row });
            await editMessage(chatId, messageId, `${message.text}\n\n⏳ Ожидает поставки`, {
              inline_keyboard: [
                [{ text: '✅ Выполнено', callback_data: `done:${row}` }]
              ]
            });
            break;

          case 'cancelled':
            await axios.post(GAS_WEB_APP_URL, { action: 'cancelled', row });
            await editMessage(chatId, messageId, `${message.text}\n\n❌ Отменено`);
            break;
        }
      } 
      // Обработка обычных сообщений
      else if (body.message) {
        const { chat, text, photo, message_id } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        if (!state) return;

        // Обработка ручного ввода подрядчика
        if (state.awaitingManualExecutor) {
          const messageIdRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getMessageId',
            row: state.row
          });

          if (messageIdRes.data?.message_id) {
            await assignExecutor(chatId, state.row, text, messageIdRes.data.message_id);
          }
          return;
        }

        // Обработка по этапам работы
        switch(state.stage) {
          case 'awaiting_photo':
            if (photo) {
              await handlePhoto(chatId, photo, message_id);
            } else {
              await sendMessage(chatId, 'Пожалуйста, пришлите фото выполнения работы.');
            }
            break;

          case 'awaiting_amount':
            await handleAmount(chatId, text, message_id);
            break;

          case 'awaiting_comment':
            await completeRequest(chatId, text, message_id);
            break;
        }
      }
    } catch (error) {
      console.error('Ошибка в обработчике webhook:', error);
    }
  });

  // ==================== ИНТЕРФЕЙС ДЛЯ GAS ====================
  return {
    handleNewRequest,
    cleanupMessages
  };
};
