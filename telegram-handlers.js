const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// Права пользователей
const MANAGERS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const EXECUTORS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Хранилища данных
const userStorage = new Map(); // username → user_id
const userStates = {}; // Текущие состояния пользователей
const activeRequests = new Map(); // message_id → requestData

// Вспомогательные функции
function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  return parts.length > 1 ? parseInt(parts[1], 10) : null;
}

function parseRequestMessage(text) {
  if (!text) return null;
  
  const result = {};
  const lines = text.split('\n');
  
  lines.forEach(line => {
    if (line.includes('Пиццерия:')) result.pizzeria = line.split(':')[1].trim();
    if (line.includes('Проблема:')) result.problem = line.split(':')[1].trim();
    if (line.includes('Срок:')) result.deadline = line.split(':')[1].trim();
  });
  
  return result;
}

function calculateDelayDays(deadline) {
  if (!deadline || deadline === 'не указан') return 0;
  try {
    const deadlineDate = new Date(deadline);
    const today = new Date();
    return Math.max(0, Math.ceil((today - deadlineDate) / (1000 * 60 * 60 * 24)));
  } catch (e) {
    console.error('Error calculating delay:', e);
    return 0;
  }
}

function formatRequestMessage(data) {
  const emergencyMark = data.isEmergency ? '🚨 ' : '';
  return `
${emergencyMark}Заявка #${data.row}
🏢 Пиццерия: ${data.pizzeria || 'не указано'}
🔧 Проблема: ${data.problem || 'не указано'}
🕓 Срок: ${data.deadline || 'не указан'}
━━━━━━━━━━━━
${data.status === 'В работе' ? `🟢 В работе (исполнитель: ${data.executor})` : '🟠 Новый запрос'}
  `.trim();
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

// Telegram API функции
async function sendMessage(chatId, text, options = {}) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    }, { timeout: 5000 });
    return response.data.result;
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
    return response.data.result;
  } catch (error) {
    if (error.response?.data?.description?.includes('message to edit not found')) {
      return await sendMessage(chatId, text, options);
    }
    console.error('Edit message error:', error.response?.data);
    throw error;
  }
}

async function deleteMessageSafe(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    }, { timeout: 3000 });
  } catch (error) {
    console.error('Delete message error:', error.response?.data);
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text || '',
      show_alert: !!text
    }, { timeout: 2000 });
    return response.data;
  } catch (error) {
    if (!error.response?.data?.description?.includes('query is too old')) {
      console.error('Callback answer error:', error.response?.data || error.message);
    }
    return null;
  }
}

async function getTelegramFileUrl(fileId) {
  try {
    const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    return `${TELEGRAM_FILE_API}/${data.result.file_path}`;
  } catch (error) {
    console.error('Get file URL error:', error.response?.data);
    return null;
  }
}

// GAS функции
async function sendToGAS(data) {
  try {
    const response = await axios.post(GAS_WEB_APP_URL, data, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  } catch (error) {
    console.error('Error sending to GAS:', error.message);
    throw error;
  }
}

async function getGoogleDiskLink(row) {
  try {
    const res = await axios.post(`${GAS_WEB_APP_URL}?getDiskLink=true`, { row });
    return res.data.diskLink || null;
  } catch (error) {
    console.error('Get Google Disk link error:', error.response?.data);
    return null;
  }
}

// Основной обработчик
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

        // Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          const msg = await sendMessage(chatId, '❌ У вас нет доступа к этой операции');
          setTimeout(() => deleteMessageSafe(chatId, msg.message_id), 30000);
          return res.sendStatus(200);
        }

        // Извлечение номера заявки
        const row = extractRowFromCallbackData(data);
        if (!row) {
          console.error('Не удалось извлечь номер заявки');
          return res.sendStatus(200);
        }

        // Получаем данные заявки
        let requestData = activeRequests.get(messageId) || parseRequestMessage(message.text || message.caption);
        requestData.row = row;
        requestData.message_id = messageId;

        // Обработка действий
        if (data === 'accept') {
          if (!MANAGERS.includes(username)) {
            await answerCallbackQuery(id, '❌ Только менеджеры могут принимать заявки');
            return res.sendStatus(200);
          }

          requestData.status = 'В работе';
          requestData.manager = username;
          activeRequests.set(messageId, requestData);

          await editMessageSafe(chatId, messageId, formatRequestMessage(requestData), {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Назначить исполнителя', callback_data: `assign:${row}` }]
              ]
            }
          });

          await answerCallbackQuery(id, '✅ Заявка принята');
        }
        else if (data.startsWith('assign:')) {
          if (!MANAGERS.includes(username)) {
            await answerCallbackQuery(id, '❌ Только менеджеры могут назначать');
            return res.sendStatus(200);
          }

          // Показываем список исполнителей
          const buttons = EXECUTORS.map(executor => [{
            text: executor,
            callback_data: `set_executor:${executor}:${row}`
          }]);

          await editMessageSafe(chatId, messageId, 'Выберите исполнителя:', {
            reply_markup: { inline_keyboard: buttons }
          });

          await answerCallbackQuery(id);
        }
        else if (data.startsWith('set_executor:')) {
          const executor = data.split(':')[1];
          requestData.executor = executor;
          requestData.status = 'В работе';
          activeRequests.set(messageId, requestData);

          // Обновляем сообщение в чате
          await editMessageSafe(chatId, messageId, formatRequestMessage(requestData), {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Выполнено', callback_data: `complete:${row}` },
                  { text: '⏳ Ожидает', callback_data: `wait:${row}` }
                ]
              ]
            }
          });

          // Отправляем уведомление исполнителю
          const executorId = userStorage.get(executor);
          if (executorId) {
            await sendMessage(executorId, `📌 Вам назначена заявка #${row}`, {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Выполнено', callback_data: `complete:${row}` },
                    { text: '⏳ Ожидает', callback_data: `wait:${row}` }
                  ]
                ]
              }
            });
          }

          await sendToGAS(requestData);
          await answerCallbackQuery(id, `✅ Исполнитель ${executor} назначен`);
        }
        else if (data.startsWith('complete:')) {
          if (!EXECUTORS.includes(username)) {
            await answerCallbackQuery(id, '❌ Только исполнители могут завершать');
            return res.sendStatus(200);
          }

          userStates[chatId] = {
            stage: 'waiting_photo',
            row,
            messageId,
            username,
            requestData
          };

          await sendMessage(chatId, '📸 Пришлите фото выполненных работ');
          await answerCallbackQuery(id);
        }
        else if (data.startsWith('wait:')) {
          requestData.status = 'Ожидает поставки';
          await sendToGAS(requestData);
          await editMessageSafe(chatId, messageId, formatRequestMessage(requestData));
          await answerCallbackQuery(id, '⏳ Заявка ожидает поставки');
        }

        return res.sendStatus(200);
      }

      // Обработка сообщений (для завершения заявки)
      if (message && userStates[message.chat.id]) {
        const chatId = message.chat.id;
        const state = userStates[chatId];
        const requestData = state.requestData;

        if (state.stage === 'waiting_photo' && message.photo) {
          const fileId = message.photo[message.photo.length - 1].file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          state.stage = 'waiting_sum';
          await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
        }
        else if (state.stage === 'waiting_sum' && message.text) {
          state.sum = message.text;
          state.stage = 'waiting_comment';
          await sendMessage(chatId, '💬 Введите комментарий');
        }
        else if (state.stage === 'waiting_comment' && message.text) {
          const completionData = {
            ...requestData,
            status: 'Выполнено',
            executor: state.username,
            photoUrl: state.photoUrl,
            sum: state.sum,
            comment: message.text,
            delayDays: calculateDelayDays(requestData.deadline)
          };

          // Обновляем сообщение в чате
          await editMessageSafe(chatId, state.messageId, formatCompletionMessage(completionData), {
            reply_markup: { inline_keyboard: [] }
          });

          // Отправляем данные в GAS
          await sendToGAS(completionData);

          // Обновляем ссылку на Google Disk через 3 минуты
          setTimeout(async () => {
            try {
              const diskUrl = await getGoogleDiskLink(state.row);
              if (diskUrl) {
                await editMessageSafe(chatId, state.messageId, formatCompletionMessage({
                  ...completionData,
                  photoUrl: diskUrl
                }));
              }
            } catch (e) {
              console.error('Error updating disk link:', e);
            }
          }, 180000);

          delete userStates[chatId];
        }

        return res.sendStatus(200);
      }

      // Обработка новых заявок
      if (message?.text && message.text.startsWith('#')) {
        const requestData = {
          message_id: message.message_id,
          row: parseInt(message.text.match(/#(\d+)/)?.[1]) || null,
          ...parseRequestMessage(message.text),
          isEmergency: message.text.includes('🚨'),
          status: 'Новая'
        };

        activeRequests.set(message.message_id, requestData);

        await sendMessage(message.chat.id, formatRequestMessage(requestData), {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Принять заявку', callback_data: `accept:${requestData.row}` }]
            ]
          }
        });

        if (requestData.isEmergency) {
          for (const manager of MANAGERS) {
            const managerId = userStorage.get(manager);
            if (managerId) {
              await sendMessage(managerId, `🚨 Новая аварийная заявка #${requestData.row}`, {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: 'Принять заявку', callback_data: `accept:${requestData.row}` }]
                  ]
                }
              });
            }
          }
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(500);
    }
  });
};
