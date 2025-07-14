module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
  const DELAY_BEFORE_DELETE = 15000;

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
      console.log('Начало обработки фото...');
      
      // Получаем информацию о файле (используем самое качественное фото)
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length - 1].file_id}`);
      console.log('Информация о файле получена:', fileRes.data);
      
      const filePath = fileRes.data.result.file_path;
      const photoUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      
      // Обновляем состояние
      const newState = {
        ...state,
        photoUrl,
        userResponses: [...(state.userResponses || []), messageId],
        stage: 'awaiting_amount'
      };
      userStates[chatId] = newState;

      const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
      userStates[chatId].serviceMessages = [prompt];
      
      console.log('Обработка фото завершена. URL фото:', photoUrl);
    } catch (error) {
      console.error('Ошибка при обработке фото:', error);
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото. Попробуйте еще раз.');
    }
  }

  async function handleAmount(chatId, text, messageId, state) {
    try {
      const newState = {
        ...state,
        amount: text,
        userResponses: [...(state.userResponses || []), messageId],
        stage: 'awaiting_comment'
      };
      userStates[chatId] = newState;
      
      const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
      userStates[chatId].serviceMessages = [prompt];
    } catch (error) {
      console.error('Ошибка при обработке суммы:', error);
      await sendMessage(chatId, '⚠️ Ошибка. Попробуйте еще раз.');
    }
  }

  async function completeRequest(chatId, text, messageId, state) {
    try {
      if (!state.executor) {
        throw new Error('Исполнитель не указан');
      }

      const newState = {
        ...state,
        comment: text,
        userResponses: [...(state.userResponses || []), messageId]
      };
      userStates[chatId] = newState;

      // Получаем оригинальный текст заявки
      const originalTextRes = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row: state.row
      });
      
      const originalText = originalTextRes.data?.text || '';
      
      // Формируем обновленный текст
      const updatedText = `✅ Выполнено
👷 Исполнитель: ${state.executor}
💰 Сумма: ${state.amount || 'не указана'}
📸 Фото: ${state.photoUrl ? 'есть' : 'отсутствует'}
📝 Комментарий: ${state.comment || 'не указан'}

━━━━━━━━━━━━

${originalText}`;

      // Подготавливаем данные для GAS
      const gasData = {
        action: 'complete',
        row: state.row,
        photoUrl: state.photoUrl,
        amount: state.amount,
        comment: state.comment,
        executor: state.executor,
        message_id: state.originalMessageId
      };

      console.log('Отправка данных в Google Sheets:', JSON.stringify(gasData, null, 2));

      // Отправляем данные в Google Sheets
      const gasResponse = await axios.post(GAS_WEB_APP_URL, gasData);
      console.log('Ответ от Google Sheets:', gasResponse.data);

      if (gasResponse.data?.error) {
        throw new Error(gasResponse.data.error);
      }

      // Обновляем сообщение
      await editMessageText(chatId, state.originalMessageId, updatedText);
      
      // Удаляем временные сообщения
      await cleanupMessages(chatId, state);
      
      // Очищаем состояние
      delete userStates[chatId];
      
    } catch (error) {
      console.error('Ошибка при завершении заявки:', error);
      await sendMessage(chatId, `⚠️ Ошибка при завершении заявки: ${error.message}`);
    }
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      console.log('Входящий webhook:', JSON.stringify(body, null, 2));
      
      // Быстрый ответ серверу Telegram
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

        console.log(`Действие: ${action}, Строка: ${row}, Исполнитель: ${executor}`);

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

          try {
            const [originalIdRes, originalTextRes] = await Promise.all([
              axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
              axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
            ]);

            const originalMessageId = originalIdRes.data?.message_id;
            const originalText = originalTextRes.data?.text || '';

            if (!originalMessageId) {
              throw new Error('Не удалось получить message_id');
            }

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
          } catch (error) {
            console.error('Ошибка при выборе исполнителя:', error);
            await sendMessage(chatId, '⚠️ Ошибка при обработке запроса. Попробуйте еще раз.');
          }
        }
        else if (action === 'done') {
          if (userStates[chatId]?.stage === 'awaiting_photo') return;

          try {
            const originalIdRes = await axios.post(GAS_WEB_APP_URL, {
              action: 'getMessageId',
              row
            });
            const originalMessageId = originalIdRes.data?.message_id;

            if (!originalMessageId) {
              throw new Error('Не удалось получить message_id');
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
            console.error('Ошибка при обработке завершения:', error);
            await sendMessage(chatId, '⚠️ Ошибка при обработке запроса. Попробуйте еще раз.');
          }
        }
        else if (action === 'delayed') {
          try {
            await axios.post(GAS_WEB_APP_URL, { 
              action: 'delayed', 
              row
            });
            
            const buttons = buildDelayedButtons(row);
            const updatedText = `${message.text}\n\n⏳ Ожидает поставки`;
            await editMessageText(chatId, messageId, updatedText, buttons);
          } catch (error) {
            console.error('Ошибка при отметке задержки:', error);
            await sendMessage(chatId, '⚠️ Ошибка при обработке запроса. Попробуйте еще раз.');
          }
        }
        else if (action === 'cancelled') {
          try {
            await axios.post(GAS_WEB_APP_URL, { 
              action: 'cancelled', 
              row
            });
            const updatedText = `${message.text}\n\n❌ Отменено`;
            await editMessageText(chatId, messageId, updatedText);
          } catch (error) {
            console.error('Ошибка при отмене:', error);
            await sendMessage(chatId, '⚠️ Ошибка при обработке запроса. Попробуйте еще раз.');
          }
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
          } catch (error) {
            console.error('Ошибка при обработке ручного ввода исполнителя:', error);
            await sendMessage(chatId, '⚠️ Ошибка при обработке запроса. Попробуйте еще раз.');
          }
        }
        else if (state.stage === 'awaiting_photo' && photo) {
          console.log('Обработка фото для чата:', chatId);
          await handlePhoto(chatId, photo, message_id, state);
        }
        else if (state.stage === 'awaiting_amount') {
          await handleAmount(chatId, text, message_id, state);
        }
        else if (state.stage === 'awaiting_comment') {
          await completeRequest(chatId, text, message_id, state);
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
