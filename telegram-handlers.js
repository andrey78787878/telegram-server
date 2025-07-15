module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

// Хранилище состояний пользователей
const userStates = {};

// Импортируем обработчики Telegram
require('./telegram-handlers')(app, userStates);

// Тестовый endpoint для проверки работы сервера
app.get('/', (req, res) => {
  res.send('Telegram Bot is running!');
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Экспорт для тестов
module.exports = app;
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

  // ... (все остальные функции остаются без изменений, как в предыдущем исправленном коде)

  // Главное изменение - убедитесь, что все обработчики правильно обернуты:
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      console.log('Webhook received:', JSON.stringify(body, null, 2));

      // Обработка callback_query
      if (body.callback_query) {
        const { data, message } = body.callback_query;
        const chatId = message.chat.id;
        
        // Добавьте здесь обработку callback как в предыдущем коде
        // Убедитесь, что все await находятся внутри async функций
      }

      // Обработка обычных сообщений
      if (body.message) {
        const { chat, text } = body.message;
        // ... обработка сообщений
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      res.sendStatus(500);
    }
  });
};
  // Улучшенное логирование
  function logAction(chatId, action, data = {}) {
    console.log(`[ACTION] ${new Date().toISOString()} Chat ${chatId}: ${action}`, data);
  }

  function logError(chatId, error, context = '') {
    console.error(`[ERROR] ${new Date().toISOString()} Chat ${chatId}: ${context}`, error.stack || error);
  }

  // Функция для создания кнопок выбора исполнителя
  function buildExecutorButtons(row) {
    return {
      inline_keyboard: EXECUTORS.map(ex => [
        { text: ex, callback_data: `select_executor:${row}:${ex}` }
      ])
    };
  }

  // Функция для создания кнопок действий (выполнено/ожидает/отмена)
  function buildActionButtons(row) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Выполнено', callback_data: `done:${row}` },
          { text: '⏳ Ожидает поставки', callback_data: `delayed:${row}` },
          { text: '❌ Отмена', callback_data: `cancelled:${row}` }
        ]
      ]
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
      logAction(chatId, 'Message sent', { text });
      return res.data.result.message_id;
    } catch (error) {
      logError(chatId, error, 'sendMessage');
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
      logAction(chatId, 'Message edited', { messageId, text: text.substring(0, 50) + '...' });
    } catch (error) {
      logError(chatId, error, 'editMessageText');
    }
  }

  // Функция удаления сообщений
  async function deleteMessage(chatId, msgId) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
      logAction(chatId, 'Message deleted', { msgId });
    } catch (e) {
      logError(chatId, e, 'deleteMessage');
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
        logAction(chatId, 'Cleaning up messages', { count: messagesToDelete.length });
        await Promise.all(messagesToDelete.map(msgId => 
          deleteMessage(chatId, msgId)
        ));
      }
    } catch (error) {
      logError(chatId, error, 'cleanupMessages');
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
      
      logAction(chatId, 'Photo received', { photoUrl: state.photoUrl });
    } catch (error) {
      logError(chatId, error, 'handlePhoto');
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото. Попробуйте еще раз.');
    }
  }

  // Обработка введенной суммы
  async function handleAmount(chatId, text, messageId, state) {
    try {
      // Проверяем, что сумма - число
      if (!/^\d+$/.test(text)) {
        await sendMessage(chatId, '⚠️ Пожалуйста, введите сумму цифрами без пробелов и символов.');
        return false;
      }

      // Удаляем предыдущие временные сообщения
      await cleanupMessages(chatId, state);

      state.amount = text;
      // Сохраняем ID сообщения с суммой
      state.userResponses = [messageId];

      // Запрашиваем комментарий
      const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
      state.serviceMessages = [prompt];
      state.stage = 'awaiting_comment';
      
      logAction(chatId, 'Amount received', { amount: state.amount });
      return true;
    } catch (error) {
      logError(chatId, error, 'handleAmount');
      await sendMessage(chatId, '⚠️ Ошибка. Попробуйте еще раз.');
      return false;
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
      
      logAction(chatId, 'Request completed', { row: state.row });
    } catch (error) {
      logError(chatId, error, 'completeRequest');
      await sendMessage(chatId, '⚠️ Ошибка при завершении заявки. Попробуйте еще раз.');
    }
  }

  // Обработчик вебхука
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      logAction('system', 'Webhook received', { update_id: body.update_id });

      // Обработка callback_query (нажатия кнопок)
      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        logAction(chatId, 'Button pressed', { 
          buttonData: raw,
          messageId,
          from: from.username || from.id
        });

        // Отвечаем на callback
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { 
          callback_query_id: callbackId 
        }).catch(e => logError(chatId, e, 'answerCallbackQuery'));

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
          
          logAction(chatId, 'In progress - showing executors');
          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя
        if (action === 'select_executor') {
          if (!userStates[chatId]) {
            userStates[chatId] = {};
            logAction(chatId, 'New state created for executor selection');
          }

          // Ручной ввод исполнителя
          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            userStates[chatId].row = row;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            
            logAction(chatId, 'Manual executor requested');
            return res.sendStatus(200);
          }

          // Получаем данные о заявке
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) {
            logError(chatId, 'Original message ID not found', 'select_executor');
            return res.sendStatus(200);
          }

          // Обновляем статус в Google Sheets
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row, 
            executor, 
            message_id: originalMessageId 
          });

          // Формируем обновленное сообщение
          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
          const buttons = buildActionButtons(row);

          await editMessageText(chatId, originalMessageId, updatedText, buttons);
          
          // Если это не исходное сообщение - очищаем кнопки
          if (originalMessageId !== messageId) {
            await editMessageText(chatId, messageId, message.text);
          }

          // Сохраняем состояние
          userStates[chatId] = {
            ...userStates[chatId],
            row,
            executor,
            sourceMessageId: originalMessageId,
            originalMessageId,
            awaiting_manual_executor: false,
            serviceMessages: [],
            userResponses: []
          };

          logAction(chatId, 'Executor selected', { executor, row });
          return res.sendStatus(200);
        }

        // Обработка действия "Выполнено"
        if (action === 'done') {
          // Проверяем, не начат ли уже процесс завершения
          if (userStates[chatId]?.stage === 'awaiting_photo') {
            logAction(chatId, 'Already in completion process');
            return res.sendStatus(200);
          }

          const originalIdRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getMessageId',
            row
          });
          const originalMessageId = originalIdRes.data?.message_id;

          if (!originalMessageId) {
            logError(chatId, 'Original message ID not found for done action');
            return res.sendStatus(200);
          }

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

          logAction(chatId, 'Completion process started', { row });
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
          
          logAction(chatId, 'Request delayed', { row });
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
          
          logAction(chatId, 'Request cancelled', { row });
          return res.sendStatus(200);
        }
      }

      // Обработка обычных сообщений
      if (body.message) {
        const { chat, message_id, text, photo } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        logAction(chatId, 'Message received', { 
          text: text || '(photo)', 
          state: state ? JSON.stringify(state) : 'no state' 
        });

        if (!state) return res.sendStatus(200);

        // Ручной ввод исполнителя
        if (state.awaiting_manual_executor) {
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row: state.row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row: state.row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) {
            logError(chatId, 'Original message ID not found for manual executor');
            return res.sendStatus(200);
          }

          // Обновляем статус в Google Sheets
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row: state.row, 
            executor: text, 
            message_id: originalMessageId 
          });

          // Формируем обновленное сообщение
          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${text}`;
          const buttons = buildActionButtons(state.row);

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

          logAction(chatId, 'Manual executor received', { executor: text });
          return res.sendStatus(200);
        }

        // Обработка фото выполнения
        if (state.stage === 'awaiting_photo' && photo) {
          await handlePhoto(chatId, photo, message_id, state);
          return res.sendStatus(200);
        }

        // Обработка введенной суммы
        if (state.stage === 'awaiting_amount') {
          const success = await handleAmount(chatId, text, message_id, state);
          if (!success) return res.sendStatus(200); // Не удаляем сообщение при ошибке
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
      logError('system', err, 'webhook');
      res.sendStatus(500);
    }
  });
};
