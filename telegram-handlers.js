const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// Права пользователей
const MANAGERS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85', '@Andrey_tkach_y'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Хранилища
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

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text || '',
      show_alert: !!text
    }, { timeout: 2000 });
  } catch (error) {
    console.error('Callback answer error:', error.response?.data);
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

// Основной обработчик
module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const { message, callback_query } = req.body;

      // Сохраняем user_id
      if (message?.from?.username) {
        userStorage.set(`@${message.from.username}`, message.from.id);
      }

      // Обработка callback_query
      if (callback_query) {
        const { id, from, message, data } = callback_query;
        const username = from.username ? `@${from.username}` : null;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        // Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          await answerCallbackQuery(id, '❌ Нет доступа');
          return res.sendStatus(200);
        }

        // Извлечение номера заявки
        const row = extractRowFromCallbackData(data) || parseInt(message.text?.match(/#(\d+)/)?.[1]);
        if (!row) {
          await answerCallbackQuery(id, '❌ Не удалось определить заявку');
          return res.sendStatus(200);
        }

        // Получаем данные заявки
        const requestData = parseRequestMessage(message.text) || {};
        requestData.row = row;
        requestData.message_id = messageId;
        requestData.chatId = chatId;

        // Обработка действий
        if (data === 'accept') {
          if (!MANAGERS.includes(username)) {
            await answerCallbackQuery(id, '❌ Только для менеджеров');
            return res.sendStatus(200);
          }

          requestData.status = 'В работе';
          requestData.manager = username;
          activeRequests.set(messageId, requestData);

          await editMessageSafe(chatId, messageId, `
🟢 Заявка #${row} принята
🏢 Пиццерия: ${requestData.pizzeria || 'не указано'}
🔧 Проблема: ${requestData.problem || 'не указано'}
━━━━━━━━━━━━
Менеджер: ${username}`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Назначить исполнителя', callback_data: `assign:${row}` }]
              ]
            }
          });

          await answerCallbackQuery(id, '✅ Заявка принята');
        }
        else if (data.startsWith('assign:')) {
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
          await editMessageSafe(chatId, messageId, `
🟢 Заявка #${row} в работе
🏢 Пиццерия: ${requestData.pizzeria || 'не указано'}
🔧 Проблема: ${requestData.problem || 'не указано'}
━━━━━━━━━━━━
Исполнитель: ${executor}`, {
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
            await sendMessage(executorId, `
📌 Вам назначена заявка #${row}
🏢 Пиццерия: ${requestData.pizzeria || 'не указано'}
🔧 Проблема: ${requestData.problem || 'не указано'}
🕓 Срок: ${requestData.deadline || 'не указан'}`, {
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
          await answerCallbackQuery(id, `✅ Назначен исполнитель: ${executor}`);
        }
        else if (data.startsWith('complete:')) {
          userStates[chatId] = {
            stage: 'waiting_photo',
            row,
            messageId,
            username,
            requestData
          };

          await sendMessage(chatId, '📸 Пришлите фото выполненных работ');
          await answerCallbackQuery(id, 'Отправьте фото, сумму и комментарий');
        }
        else if (data.startsWith('wait:')) {
          requestData.status = 'Ожидает поставки';
          await sendToGAS(requestData);
          await editMessageSafe(chatId, messageId, `
⏳ Заявка #${row} ожидает
🏢 Пиццерия: ${requestData.pizzeria || 'не указано'}
🔧 Проблема: ${requestData.problem || 'не указано'}
━━━━━━━━━━━━
Статус: Ожидает поставки`);
          await answerCallbackQuery(id, 'Заявка переведена в ожидание');
        }

        return res.sendStatus(200);
      }

      // Обработка завершения заявки
      if (message && userStates[message.chat.id]) {
        const { chatId } = message;
        const state = userStates[chatId];
        const requestData = state.requestData;

        if (state.stage === 'waiting_photo' && message.photo) {
          const fileId = message.photo[message.photo.length - 1].file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          state.stage = 'waiting_sum';
          await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
        }
        else if (state.stage === 'waiting_sum' && message.text && !isNaN(message.text)) {
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
          await editMessageSafe(state.requestData.chatId, state.messageId, formatCompletionMessage(completionData), {
            reply_markup: { inline_keyboard: [] }
          });

          // Отправляем данные в GAS
          await sendToGAS(completionData);
          delete userStates[chatId];
          activeRequests.delete(state.messageId);
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(500);
    }
  });
};
