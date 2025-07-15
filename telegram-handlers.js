// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

app.post('/webhook', async (req, res) => {
  console.log('Received webhook:', req.body);
  try {
    // остальной код...
  } catch (err) {
    console.error('Full webhook error:', err.stack);
    res.sendStatus(500);
  }
});

  // Функция для создания кнопок выбора исполнителя
  function buildExecutorButtons(row) {
    return {
      inline_keyboard: EXECUTORS.map(ex => [
        { text: ex, callback_data: `select_executor:${row}:${ex}` }
      ])
    };
  }

  // Универсальная функция отправки сообщений
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

  // Функция редактирования сообщений
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

  // Функция удаления сообщений
  async function deleteMessage(chatId, msgId) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
    } catch (e) {
      console.warn('Не удалось удалить сообщение:', e.message);
    }
  }

  // Очистка всех временных сообщений
  async function cleanupMessages(chatId, state) {
    try {
      const messagesToDelete = [
        ...(state.serviceMessages || []),
        ...(state.userResponses || [])
      ];
      
      if (messagesToDelete.length) {
        await Promise.all(messagesToDelete.map(msgId => 
          deleteMessage(chatId, msgId)
        ));
      }
    } catch (error) {
      console.error('Ошибка при очистке сообщений:', error);
    }
  }

  // Обработка полученного фото
  async function handlePhoto(chatId, photo, messageId, state) {
    try {
      // Удаляем предыдущие временные сообщения
      await cleanupMessages(chatId, state);

      // Получаем информацию о файле
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length - 1].file_id}`);
      const filePath = fileRes.data.result.file_path;
      state.photoUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      
      // Сохраняем ID сообщения с фото
      state.userResponses = [messageId];

      // Запрашиваем сумму
      const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
      state.serviceMessages = [prompt];
      state.stage = 'awaiting_amount';
      
    } catch (error) {
      console.error('Ошибка при обработке фото:', error);
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото. Попробуйте еще раз.');
    }
  }

  // Обработка введенной суммы
  async function handleAmount(chatId, text, messageId, state) {
    try {
      // Удаляем предыдущие временные сообщения
      await cleanupMessages(chatId, state);

      state.amount = text;
      // Сохраняем ID сообщения с суммой
      state.userResponses = [messageId];

      // Запрашиваем комментарий
      const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
      state.serviceMessages = [prompt];
      state.stage = 'awaiting_comment';
    } catch (error) {
      console.error('Ошибка при обработке суммы:', error);
      await sendMessage(chatId, '⚠️ Ошибка. Попробуйте еще раз.');
    }
  }

  // Завершение заявки
  async function completeRequest(chatId, text, messageId, state) {
    try {
      // Удаляем все временные сообщения
      await cleanupMessages(chatId, state);

      state.comment = text;
      // Сохраняем ID сообщения с комментарием
      state.userResponses = [messageId];

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

      // Отправляем все данные в Google Sheets
      await axios.post(GAS_WEB_APP_URL, {
        action: 'complete',
        row: state.row,
        photoUrl: state.photoUrl,
        status: 'Выполнено',
        amount: state.amount,
        comment: state.comment,
        message_id: state.originalMessageId
      });

      // Обновляем сообщение
      await editMessageText(chatId, state.originalMessageId, updatedText);
      
      // Очищаем состояние
      delete userStates[chatId];
      
    } catch (error) {
      console.error('Ошибка при завершении заявки:', error);
      await sendMessage(chatId, '⚠️ Ошибка при завершении заявки. Попробуйте еще раз.');
    }
  }

  // Обработчик вебхука
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      // Обработка callback_query (нажатия кнопок)
      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        // Отвечаем на callback
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { 
          callback_query_id: callbackId 
        }).catch(console.error);

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        // Обработка действия "Принято в работу"
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
          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя
        if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = {};

          // Ручной ввод исполнителя
          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            return res.sendStatus(200);
          }

          // Получаем данные о заявке
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) return res.sendStatus(200);

          // Обновляем статус в Google Sheets
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row, 
            executor, 
            message_id: originalMessageId 
          });

          // Формируем обновленное сообщение
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
          
          // Если это не исходное сообщение - очищаем кнопки
          if (originalMessageId !== messageId) {
            await editMessageText(chatId, messageId, message.text);
          }

          // Сохраняем состояние
          userStates[chatId] = {
            ...userStates[chatId],
            executor,
            sourceMessageId: originalMessageId,
            originalMessageId,
            awaiting_manual_executor: false,
            serviceMessages: [],
            userResponses: []
          };

          return res.sendStatus(200);
        }

        // Обработка действия "Выполнено"
        if (action === 'done') {
          // Проверяем, не начат ли уже процесс завершения
          if (userStates[chatId]?.stage === 'awaiting_photo') {
            return res.sendStatus(200);
          }

          const originalIdRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getMessageId',
            row
          });
          const originalMessageId = originalIdRes.data?.message_id;

          if (!originalMessageId) return res.sendStatus(200);

          // Инициализируем состояние для завершения заявки
          userStates[chatId] = {
            row,
            stage: 'awaiting_photo',
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };

          // Запрашиваем фото выполнения
          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения:');
          userStates[chatId].serviceMessages = [prompt];
          
          await editMessageText(chatId, originalMessageId, '📌 Ожидаем фото...');

          return res.sendStatus(200);
        }

        // Обработка действия "Ожидает поставки"
        if (action === 'delayed') {
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'delayed', 
            row,
            status: 'Ожидает поставки'
          });
          const updatedText = `${message.text}\n\n⏳ Ожидает поставки`;
          await editMessageText(chatId, messageId, updatedText);
          return res.sendStatus(200);
        }

        // Обработка действия "Отмена"
        if (action === 'cancelled') {
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'cancelled', 
            row,
            status: 'Отменено'
          });
          const updatedText = `${message.text}\n\n❌ Отменено`;
          await editMessageText(chatId, messageId, updatedText);
          return res.sendStatus(200);
        }
      }

      // Обработка обычных сообщений
      if (body.message) {
        const { chat, message_id, text, photo } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);

        // Ручной ввод исполнителя
        if (state.awaiting_manual_executor) {
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row: state.row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row: state.row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) return res.sendStatus(200);

          // Обновляем статус в Google Sheets
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row: state.row, 
            executor: text, 
            message_id: originalMessageId 
          });

          // Формируем обновленное сообщение
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
          
          // Удаляем временные сообщения
          await cleanupMessages(chatId, state);

          // Обновляем состояние
          userStates[chatId] = {
            ...state,
            executor: text,
            sourceMessageId: originalMessageId,
            originalMessageId,
            awaiting_manual_executor: false
          };

          return res.sendStatus(200);
        }

        // Обработка фото выполнения
        if (state.stage === 'awaiting_photo' && photo) {
          await handlePhoto(chatId, photo, message_id, state);
          return res.sendStatus(200);
        }

        // Обработка введенной суммы
        if (state.stage === 'awaiting_amount') {
          await handleAmount(chatId, text, message_id, state);
          return res.sendStatus(200);
        }

        // Обработка комментария и завершение заявки
        if (state.stage === 'awaiting_comment') {
          await completeRequest(chatId, text, message_id, state);
          return res.sendStatus(200);
        }

        // Если ожидается фото, но прислан текст
        if (state.stage === 'awaiting_photo' && text) {
          await sendMessage(chatId, 'Пожалуйста, пришлите фото выполнения работы.');
          return res.sendStatus(200);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
