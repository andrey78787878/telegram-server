module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
  const DELAY_BEFORE_DELETE = 15000;

  // Вспомогательные функции
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
      console.error('Ошибка отправки сообщения:', error.response?.data || error.message);
      return null;
    }
  }

  async function editMessageText(chatId, messageId, text, reply_markup) {
    try {
      const payload = {
        chat_id: chatId,
        message_id: messageId,
        text: text.substring(0, 4096), // Обрезаем текст до допустимого лимита
        parse_mode: 'HTML'
      };
      
      if (reply_markup) {
        payload.reply_markup = reply_markup;
      }
      
      const response = await axios.post(`${TELEGRAM_API}/editMessageText`, payload);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Ошибка изменения сообщения:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        payload: { chatId, messageId, textLength: text?.length }
      });
      return { success: false, error };
    }
  }

  async function deleteMessageWithDelay(chatId, msgId) {
    try {
      await new Promise(resolve => setTimeout(resolve, DELAY_BEFORE_DELETE));
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

  function buildExecutorButtons(row) {
    return {
      inline_keyboard: EXECUTORS.map(ex => [
        { text: ex, callback_data: `select_executor:${row}:${ex}` }
      ])
    };
  }

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

  async function handlePhoto(chatId, photo, messageId) {
    try {
      console.log('Начало обработки фото...');
      
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length - 1].file_id}`);
      console.log('Информация о файле получена:', fileRes.data);
      
      const filePath = fileRes.data.result.file_path;
      const photoUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      
      userStates[chatId] = {
        ...userStates[chatId],
        photoUrl,
        userResponses: [...(userStates[chatId]?.userResponses || []), messageId],
        stage: 'awaiting_amount'
      };

      const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
      userStates[chatId].serviceMessages = [prompt];
      
      console.log('Обработка фото завершена. URL фото:', photoUrl);
    } catch (error) {
      console.error('Ошибка при обработке фото:', error);
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото. Попробуйте еще раз.');
    }
  }

  async function handleAmount(chatId, text, messageId) {
    try {
      userStates[chatId] = {
        ...userStates[chatId],
        amount: text,
        userResponses: [...(userStates[chatId]?.userResponses || []), messageId],
        stage: 'awaiting_comment'
      };
      
      const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
      userStates[chatId].serviceMessages = [...(userStates[chatId]?.serviceMessages || []), prompt];
    } catch (error) {
      console.error('Ошибка при обработке суммы:', error);
      await sendMessage(chatId, '⚠️ Ошибка. Попробуйте еще раз.');
    }
  }

  async function completeRequest(chatId, text, messageId) {
    try {
      const state = userStates[chatId];
      if (!state) throw new Error('Состояние не найдено');
      
      console.log('Текущее состояние:', JSON.stringify(state, null, 2));

      const requiredFields = {
        executor: 'Исполнитель не указан',
        photoUrl: 'Фото не прикреплено',
        amount: 'Сумма не указана',
        row: 'Номер строки не определен',
        originalMessageId: 'ID сообщения не найдено'
      };
      
      const missingFields = [];
      for (const [field, error] of Object.entries(requiredFields)) {
        if (!state[field]) missingFields.push(error);
      }
      
      if (missingFields.length > 0) {
        throw new Error(`Не хватает данных:\n${missingFields.join('\n')}`);
      }

      const originalTextRes = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row: state.row
      });
      
      const originalText = originalTextRes.data?.text || '';
      
      const updatedText = `✅ Выполнено
👷 Исполнитель: ${state.executor}
💰 Сумма: ${state.amount}
📸 Фото: ${state.photoUrl ? 'есть' : 'отсутствует'}
📝 Комментарий: ${text || 'не указан'}

━━━━━━━━━━━━

${originalText}`;

      const gasResponse = await axios.post(GAS_WEB_APP_URL, {
        action: 'complete',
        row: state.row,
        photoUrl: state.photoUrl,
        amount: state.amount,
        comment: text,
        executor: state.executor,
        message_id: state.originalMessageId
      });

      console.log('Ответ от Google Sheets:', gasResponse.data);

      if (gasResponse.data?.error) {
        throw new Error(gasResponse.data.error);
      }

      const editResult = await editMessageText(chatId, state.originalMessageId, updatedText);
      
      if (!editResult.success) {
        await sendMessage(chatId, updatedText);
      }
      
      await cleanupMessages(chatId, state);
      delete userStates[chatId];
      
    } catch (error) {
      console.error('Ошибка при завершении заявки:', error);
      await sendMessage(chatId, `⚠️ Ошибка при завершении заявки: ${error.message}`);
    }
  }

  async function getMessageIdFromColumnQ(row) {
    try {
      const response = await axios.post(GAS_WEB_APP_URL, {
        action: 'getMessageId',
        row: row
      });
      
      if (response.data && response.data.message_id) {
        return response.data.message_id;
      }
      throw new Error('Не удалось получить message_id из столбца Q');
    } catch (error) {
      console.error('Ошибка при получении message_id из столбца Q:', error);
      throw error;
    }
  }

  // Обработка входящих сообщений
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      console.log('Входящий webhook:', JSON.stringify(body, null, 2));
      
      res.sendStatus(200);

      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        let messageId = message.message_id;

        console.log(`Обработка callback: ${raw} в чате ${chatId}`);

        // Отвечаем на callback
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId,
          text: "Обрабатываю...",
          show_alert: false
        }).catch(e => console.error('Ошибка ответа на callback:', e));

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        console.log(`Действие: ${action}, Строка: ${row}, Исполнитель: ${executor || 'не указан'}`);

        async function handleExecutorSelection(chatId, messageId, row, executor) {
    try {
      // Обновляем данные в таблице
      const sheetResponse = await axios.post(GAS_WEB_APP_URL, {
        action: 'update_request',
        row,
        updates: {
          status: STATUS_IN_PROGRESS,
          executor,
          message_id: messageId
        }
      });

      if (!sheetResponse.data.success) {
        throw new Error(sheetResponse.data.error || 'Ошибка обновления таблицы');
      }

      // Получаем данные для сообщения
      const requestData = await axios.post(GAS_WEB_APP_URL, {
        action: 'get_request_data',
        row
      });

      if (!requestData.data.success) {
        throw new Error('Не удалось получить данные заявки');
      }

      // Формируем текст сообщения
      const text = [
        `📍 Заявка #${row}`,
        `📅 Дата: ${requestData.data.date || '—'}`,
        `🍕 Пиццерия: ${requestData.data.pizzeria || '—'}`,
        `🔧 Тип: ${requestData.data.type || '—'}`,
        `📋 Проблема: ${requestData.data.problem || '—'}`,
        `👤 Инициатор: ${requestData.data.initiator || '—'}`,
        `📞 Тел: ${requestData.data.phone || '—'}`,
        `📸 Фото: ${requestData.data.has_photo ? 'есть' : 'нет'}`,
        `🕓 Срок: ${requestData.data.deadline || '—'}`,
        `\n🟢 ${STATUS_IN_PROGRESS} | 👷 ${executor}`
      ].join('\n');

      // Создаем кнопки
      const buttons = {
        inline_keyboard: [
          [
            { text: '✅ Выполнено', callback_data: `done:${row}` },
            { text: '⏳ Ожидает поставки', callback_data: `delayed:${row}` }
          ],
          [
            { text: '❌ Отмена', callback_data: `cancel:${row}` }
          ]
        ]
      };

      // Редактируем сообщение
      const editResult = await editMessageText(chatId, messageId, text, buttons);
      
      if (!editResult.success) {
        console.log('Создаем новое сообщение вместо редактирования');
        const newMsgId = await sendMessage(chatId, text, { reply_markup: buttons });
        if (newMsgId) {
          // Обновляем message_id в таблице
          await axios.post(GAS_WEB_APP_URL, {
            action: 'update_message_id',
            row,
            message_id: newMsgId
          });
        }
      }

      // Обновляем состояние
      userStates[chatId] = {
        executor,
        row,
        originalMessageId: messageId,
        serviceMessages: [],
        userResponses: [],
        stage: 'awaiting_photo'
      };

      return true;
    } catch (error) {
      console.error('Ошибка при обработке исполнителя:', error);
      await sendMessage(chatId, `⚠️ Ошибка: ${error.message || 'Неизвестная ошибка'}`);
      return false;
    }
  }

  // Обработка входящих сообщений
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      console.log('Входящий webhook:', JSON.stringify(body, null, 2));
      
      res.sendStatus(200);

      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        console.log(`Обработка callback: ${raw} в чате ${chatId}`);

        // Отвечаем на callback
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId,
          text: "Обрабатываю...",
          show_alert: false
        }).catch(e => console.error('Ошибка ответа на callback:', e));

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        console.log(`Действие: ${action}, Строка: ${row}, Исполнитель: ${executor || 'не указан'}`);

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
        }
        else if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = {};

          // Обработка текстового подрядчика
          if (executor === 'Текстовой подрядчик') {
            userStates[chatId] = {
              awaiting_manual_executor: true,
              row,
              originalMessageId: messageId
            };
            const prompt = await sendMessage(chatId, '✏️ Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            return;
          }

          // Обработка обычного исполнителя
          await handleExecutorSelection(chatId, messageId, row, executor);
        }
        else if (action === 'done') {
          if (userStates[chatId]?.stage === 'awaiting_photo') return;

          try {
            const originalMessageId = await getMessageIdFromColumnQ(row);
            
            if (!originalMessageId) {
              throw new Error('Не удалось получить ID сообщения из таблицы');
            }

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
          } catch (error) {
            console.error('Ошибка при обработке действия "done":', error);
            await sendMessage(chatId, '⚠️ Произошла ошибка при обработке запроса');
          }
        }
        else if (action === 'delayed') {
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'delayed', 
            row
          });
          
          const buttons = buildDelayedButtons(row);
          const updatedText = `${message.text}\n\n⏳ Ожидает поставки`;
          await editMessageText(chatId, messageId, updatedText, buttons);
        }
        else if (action === 'cancelled') {
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'cancelled', 
            row
          });
          const updatedText = `${message.text}\n\n❌ Отменено`;
          await editMessageText(chatId, messageId, updatedText);
        }
      }
      else if (body.message) {
        const { chat, message_id, text, photo } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        if (!state) {
          console.log('Состояние не найдено для чата:', chatId);
          return;
        }

        if (state.awaiting_manual_executor) {
          try {
            // Используем улучшенную функцию для обработки ручного ввода
            const success = await handleExecutorSelection(
              chatId, 
              state.originalMessageId, 
              state.row, 
              text
            );

            if (success) {
              await cleanupMessages(chatId, state);
              userStates[chatId] = {
                ...state,
                executor: text,
                awaiting_manual_executor: false,
                stage: 'awaiting_photo'
              };
            }
          } catch (error) {
            console.error('Ошибка при обработке ручного ввода исполнителя:', error);
            await sendMessage(chatId, '⚠️ Произошла ошибка при обработке исполнителя');
          }
        }
        else if (state.stage === 'awaiting_photo' && photo) {
          console.log('Обработка фото для чата:', chatId);
          await handlePhoto(chatId, photo, message_id);
        }
        else if (state.stage === 'awaiting_amount') {
          await handleAmount(chatId, text, message_id);
        }
        else if (state.stage === 'awaiting_comment') {
          await completeRequest(chatId, text, message_id);
        }
        else if (state.stage === 'awaiting_photo' && text) {
          await sendMessage(chatId, 'Пожалуйста, пришлите фото выполнения работы.');
        }
      }
    } catch (err) {
      console.error('Ошибка webhook:', err.stack);
    }
  });
};

    } catch (err) {
      console.error('Ошибка webhook:', err.stack);
    }
  });
};
