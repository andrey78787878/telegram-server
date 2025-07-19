const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const MANAGERS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const EXECUTORS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Хранилища данных
const userStorage = new Map(); // username → user_id
const requestStorage = new Map(); // message_id → requestData
const userStates = {}; // Текущие состояния пользователей

// Улучшенный ответ на callback query
async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text || ''
    }, { timeout: 2000 });
  } catch (error) {
    console.error('Callback answer error:', error.response?.data || error.message);
  }
}

// Форматирование сообщений
function formatRequestMessage(data) {
  const emergencyMark = data.isEmergency ? '🚨 ' : '';
  return `
${emergencyMark}Заявка #${data.row || 'ID:' + data.message_id}
🏢 Пиццерия: ${data.pizzeria || 'не указано'}
🔧 Проблема: ${data.problem || 'не указано'}
🕓 Срок: ${data.deadline || 'не указан'}
━━━━━━━━━━━━
${getStatusMessage(data.status, data.manager, data.executor)}
  `.trim();
}

function getStatusMessage(status, manager, executor) {
  switch(status) {
    case 'accepted':
      return `🟡 Принята (менеджер: ${manager})`;
    case 'in_progress':
      return `🟢 В работе (исполнитель: ${executor})`;
    case 'completed':
      return `✅ Завершена (исполнитель: ${executor})`;
    case 'waiting':
      return `⏳ Ожидает поставки`;
    case 'canceled':
      return `❌ Отменена`;
    default:
      return `🟠 Новый запрос`;
  }
}

function formatCompletionMessage(data) {
  return `
✅ Заявка #${data.row} ${data.isEmergency ? '🚨 (АВАРИЙНАЯ)' : ''} закрыта
${data.photoUrl ? `\n📸 Фото: ${data.photoUrl}\n` : ''}
💬 Комментарий: ${data.comment || 'нет комментария'}
💰 Сумма: ${data.sum || '0'} сум
👤 Исполнитель: ${data.executor}
${data.delayDays > 0 ? `🔴 Просрочка: ${data.delayDays} дн.` : ''}
━━━━━━━━━━━━
🏢 Пиццерия: ${data.pizzeria || 'не указано'}
🔧 Проблема: ${data.problem || 'не указано'}
  `.trim();
}

// Основные функции работы с Telegram
async function sendMessage(chatId, text, options = {}) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    }, { timeout: 5000 });
    return response.data;
  } catch (error) {
    console.error('Send message error:', error.response?.data || error.message);
    throw error;
  }
}

async function editMessageSafe(chatId, messageId, text, options = {}) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options
    }, { timeout: 5000 });
    return response.data;
  } catch (error) {
    if (error.response?.data?.description?.includes('message to edit not found')) {
      return await sendMessage(chatId, text, options);
    }
    console.error('Edit message error:', error.response?.data);
    throw error;
  }
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    }, { timeout: 3000 });
  } catch (error) {
    console.error('Delete message error:', error.response?.data);
  }
}

// Улучшенная функция работы с GAS
async function callGAS(action, data = {}) {
  try {
    const payload = { action, ...data };
    const response = await axios.post(GAS_WEB_APP_URL, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.data.success) {
      throw new Error(response.data.error || 'GAS action failed');
    }

    // Обновляем кеш при успешных операциях
    if (['update', 'complete'].includes(action) && data.message_id) {
      requestStorage.set(data.message_id, {
        ...(requestStorage.get(data.message_id) || {}),
        ...response.data.data
      });
    }

    return response.data;
  } catch (error) {
    console.error(`GAS ${action} error:`, error.message);
    throw error;
  }
}

// Уведомления
async function notifyEmergencyManagers(messageId, requestData) {
  const message = `🚨🚨🚨 АВАРИЙНАЯ ЗАЯВКА #${requestData.row}\n\n`
    + `🏢 Пиццерия: ${requestData.pizzeria}\n`
    + `🔧 Проблема: ${requestData.problem}\n`
    + `🕓 Срок: ${requestData.deadline}\n\n`
    + `‼️ ТРЕБУЕТСЯ НЕМЕДЛЕННАЯ РЕАКЦИЯ!`;

  for (const manager of MANAGERS) {
    const managerId = userStorage.get(manager);
    if (managerId) {
      try {
        await sendMessage(managerId, message, {
          disable_notification: false,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Принять заявку', callback_data: `accept:${messageId}` }
            ]]
          }
        });
      } catch (error) {
        console.error(`Failed to notify ${manager}:`, error.message);
      }
    }
  }
}

// Обработчики действий
async function handleAccept(chatId, messageId, username) {
  try {
    const response = await callGAS('update', {
      message_id: messageId,
      status: 'accepted',
      manager: username
    });

    const updatedRequest = response.data;
    requestStorage.set(messageId, updatedRequest);

    await editMessageSafe(chatId, messageId, formatRequestMessage(updatedRequest), {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Назначить исполнителя', callback_data: `assign:${messageId}` }]
        ]
      }
    });

    if (updatedRequest.isEmergency) {
      await notifyEmergencyManagers(messageId, updatedRequest);
    }

  } catch (error) {
    console.error('Accept error:', error);
    await sendMessage(chatId, '❌ Не удалось принять заявку');
  }
}

async function handleAssignExecutor(chatId, messageId, username, executor) {
  try {
    const response = await callGAS('update', {
      message_id: messageId,
      status: 'in_progress',
      executor: executor
    });

    const updatedRequest = response.data;
    requestStorage.set(messageId, updatedRequest);

    await editMessageSafe(chatId, messageId, formatRequestMessage(updatedRequest), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Выполнено', callback_data: `complete:${messageId}` },
            { text: '⏳ Ожидает', callback_data: `wait:${messageId}` },
            { text: '❌ Отмена', callback_data: `cancel:${messageId}` }
          ]
        ]
      }
    });

    const executorId = userStorage.get(executor);
    if (executorId) {
      await sendMessage(executorId, `📌 Вам назначена заявка:\n\n${formatRequestMessage(updatedRequest)}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Выполнено', callback_data: `complete:${messageId}` },
              { text: '⏳ Ожидает', callback_data: `wait:${messageId}` }
            ]
          ]
        }
      });
    }

  } catch (error) {
    console.error('Assign error:', error);
    await sendMessage(chatId, '❌ Не удалось назначить исполнителя');
  }
}

async function handleCompleteRequest(chatId, messageId, username) {
  try {
    const request = requestStorage.get(messageId) || 
                   (await callGAS('get', { message_id: messageId })).data;

    userStates[chatId] = {
      stage: 'waiting_photo',
      messageId,
      username,
      request
    };

    await sendMessage(chatId, '📸 Пришлите фото выполненных работ', {
      reply_to_message_id: messageId
    });

  } catch (error) {
    console.error('Complete init error:', error);
    await sendMessage(chatId, '❌ Ошибка при начале завершения заявки');
  }
}

async function handleCompletionData(chatId, message, state) {
  try {
    if (state.stage === 'waiting_photo' && message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      state.photoUrl = `${TELEGRAM_FILE_API}/getFile?file_id=${fileId}`;
      state.stage = 'waiting_sum';
      await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
      return;
    }

    if (state.stage === 'waiting_sum' && message.text) {
      state.sum = message.text;
      state.stage = 'waiting_comment';
      await sendMessage(chatId, '💬 Введите комментарий');
      return;
    }

    if (state.stage === 'waiting_comment' && message.text) {
      const response = await callGAS('complete', {
        message_id: state.messageId,
        executor: state.username,
        photoUrl: state.photoUrl,
        sum: state.sum,
        comment: message.text
      });

      await editMessageSafe(
        chatId,
        state.messageId,
        formatCompletionMessage(response.data),
        { reply_markup: { inline_keyboard: [] } }
      );

      delete userStates[chatId];
    }
  } catch (error) {
    console.error('Completion error:', error);
    await sendMessage(chatId, '❌ Ошибка при завершении заявки');
    delete userStates[chatId];
  }
}

// Основной обработчик вебхука
module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const { message, callback_query } = req.body;

      // Сохраняем информацию о пользователях
      if (message?.from) {
        const user = message.from;
        if (user.username) {
          userStorage.set(`@${user.username}`, user.id);
        }
      }

      // Обработка callback-запросов
      if (callback_query) {
        const { id, from, message, data } = callback_query;
        const username = from.username ? `@${from.username}` : null;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        await answerCallbackQuery(id);

        // Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          const msg = await sendMessage(chatId, '❌ У вас нет доступа к этой операции');
          setTimeout(() => deleteMessage(chatId, msg.message_id), 30000);
          return res.sendStatus(200);
        }

        // Разбор действия
        const [action, param] = data.split(':');

        switch(action) {
          case 'accept':
            await handleAccept(chatId, messageId, username);
            break;

          case 'assign':
            await editMessageSafe(chatId, messageId, 'Выберите исполнителя:', {
              reply_markup: {
                inline_keyboard: EXECUTORS.map(executor => [{
                  text: executor,
                  callback_data: `set_executor:${executor}:${messageId}`
                }])
              }
            });
            break;

          case 'set_executor':
            await handleAssignExecutor(chatId, messageId, username, param);
            break;

          case 'complete':
            await handleCompleteRequest(chatId, messageId, username);
            break;

          case 'wait':
            await callGAS('update', {
              message_id: messageId,
              status: 'waiting'
            });
            await editMessageSafe(chatId, messageId, formatRequestMessage({
              ...(requestStorage.get(messageId) || {}),
              status: 'waiting'
            }));
            break;

          case 'cancel':
            await callGAS('update', {
              message_id: messageId,
              status: 'canceled'
            });
            await editMessageSafe(chatId, messageId, formatRequestMessage({
              ...(requestStorage.get(messageId) || {}),
              status: 'canceled'
            }));
            break;
        }
      }

      // Обработка сообщений (для завершения заявки)
      if (message && userStates[message.chat.id]) {
        await handleCompletionData(message.chat.id, message, userStates[message.chat.id]);
      }

      // Обработка новых заявок
      if (message?.text && message.text.startsWith('#') && !requestStorage.get(message.message_id)) {
        const requestData = {
          message_id: message.message_id,
          row: parseInt(message.text.match(/#(\d+)/)?.[1]) || null,
          pizzeria: message.text.match(/Пиццерия:\s*(.+)/)?.[1] || 'не указано',
          problem: message.text.match(/Проблема:\s*(.+)/)?.[1] || 'не указано',
          deadline: message.text.match(/Срок:\s*(.+)/)?.[1] || 'не указан',
          isEmergency: message.text.includes('🚨'),
          status: 'new'
        };

        requestStorage.set(message.message_id, requestData);

        await sendMessage(message.chat.id, formatRequestMessage(requestData), {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Принять заявку', callback_data: `accept:${message.message_id}` }]
            ]
          }
        });

        if (requestData.isEmergency) {
          await notifyEmergencyManagers(message.message_id, requestData);
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(200);
    }
  });
};
