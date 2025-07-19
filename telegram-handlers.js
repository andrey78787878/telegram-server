const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const MESSAGE_LIFETIME = 60000;
const MANAGERS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const EXECUTORS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];
const userStorage = new Map();
const userStates = {};

// Улучшенный ответ на callback query
async function answerCallbackQuery(callbackQueryId) {
  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId
    }, { timeout: 2000 });
  } catch (error) {
    if (!error.response?.data?.description?.includes('query is too old')) {
      console.error('Callback answer error:', error.response?.data || error.message);
    }
  }
}

// Вспомогательные функции
function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  return parts.length > 1 ? parseInt(parts[1], 10) : null;
}

function extractRowFromMessage(text) {
  if (!text) return null;
  const match = text.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
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

function formatInProgressMessage(row, requestData, executor, isEmergency = false) {
  return `
📌 Заявка #${row} ${isEmergency ? '🚨 АВАРИЙНАЯ' : ''}
🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}
🔧 Проблема: ${requestData?.problem || 'не указано'}
🕓 Срок: ${requestData?.deadline || 'не указан'}
━━━━━━━━━━━━
🟢 В работе (исполнитель: ${executor})
  `.trim();
}

function formatCompletionMessage(data, photoUrl = null) {
  return `
✅ Заявка #${data.row} ${data.isEmergency ? '🚨 (АВАРИЙНАЯ)' : ''} закрыта
${photoUrl ? `\n📸 ${photoUrl}\n` : ''}
💬 Комментарий: ${data.comment || 'нет комментария'}
💰 Сумма: ${data.sum || '0'} сум
👤 Исполнитель: ${data.executor}
${data.delayDays > 0 ? `🔴 Просрочка: ${data.delayDays} дн.` : ''}
━━━━━━━━━━━━
🏢 Пиццерия: ${data.originalRequest?.pizzeria || 'не указано'}
🔧 Проблема: ${data.originalRequest?.problem || 'не указано'}
  `.trim();
}

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
    console.error('Send message error:', {
      chatId,
      error: error.response?.data || error.message
    });
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

async function sendToGAS(data) {
  const MAX_RETRIES = 3;
  let attempt = 0;
  
  while (attempt < MAX_RETRIES) {
    try {
      const response = await axios.post(GAS_WEB_APP_URL, data, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.data && typeof response.data === 'object') {
        return response.data;
      }
      throw new Error('Invalid response format');
    } catch (error) {
      attempt++;
      console.error(`Attempt ${attempt} failed:`, error.message);
      if (attempt >= MAX_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function notifyEmergencyManagers(row, requestData) {
  const message = `🚨🚨🚨 АВАРИЙНАЯ ЗАЯВКА #${row}\n\n`
    + `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n`
    + `🔧 Проблема: ${requestData?.problem || 'не указано'}\n`
    + `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n`
    + `‼️ ТРЕБУЕТСЯ НЕМЕДЛЕННАЯ РЕАКЦИЯ!`;

  const sendPromises = MANAGERS.map(async manager => {
    const managerId = userStorage.get(manager);
    if (managerId) {
      try {
        await sendMessage(managerId, message, { disable_notification: false });
      } catch (error) {
        console.error(`Failed to notify ${manager}:`, error.message);
      }
    }
  });

  await Promise.all(sendPromises);
}

function getActionButtons(row) {
  return [
    [
      { text: '✅ Выполнено', callback_data: `done:${row}` },
      { text: '⏳ Ожидает', callback_data: `wait:${row}` },
      { text: '❌ Отмена', callback_data: `cancel:${row}` }
    ]
  ];
}

async function handleAccept(chatId, messageId, username, row, message) {
  const isEmergency = (message.text || message.caption || '').includes('🚨');
  const requestData = parseRequestMessage(message.text || message.caption || '');

  const updatedText = `${message.text || message.caption || ''}\n\n🟢 Принята в работу (менеджер: ${username})`;

  await editMessageSafe(chatId, messageId, updatedText, {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Назначить исполнителя', callback_data: `assign:${row}` }]
      ]
    }
  });

  if (isEmergency) {
    await notifyEmergencyManagers(row, requestData);
  }

  await sendToGAS({
    row,
    status: isEmergency ? 'Аварийная' : 'Принята в работу',
    manager: username,
    isEmergency
  });
}

async function handleSetExecutor(chatId, messageId, data, row, message) {
  const executor = data.split(':')[1];
  const requestData = parseRequestMessage(message.text || message.caption || '');
  const isEmergency = (message.text || message.caption || '').includes('🚨');

  await editMessageSafe(
    chatId, 
    messageId, 
    formatInProgressMessage(row, requestData, executor, isEmergency),
    { reply_markup: { inline_keyboard: getActionButtons(row) } }
  );

  const executorId = userStorage.get(executor);
  if (executorId) {
    await sendMessage(
      executorId,
      `📌 Вам назначена заявка #${row}\n\n` +
      `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
      `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
      `🕓 Срок: ${requestData?.deadline || 'не указан'}`,
      { reply_markup: { inline_keyboard: getActionButtons(row) } }
    );
  }

  await sendToGAS({
    row,
    status: 'В работе',
    executor,
    isEmergency
  });
}

module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      
      if (body.message?.from) {
        const user = body.message.from;
        if (user.username) {
          userStorage.set(`@${user.username}`, user.id);
        }
      }

      if (body.callback_query) {
        const { callback_query } = body;
        const user = callback_query.from;
        const username = user.username ? `@${user.username}` : null;
        const chatId = callback_query.message.chat.id;
        const messageId = callback_query.message.message_id;
        const data = callback_query.data;
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(callback_query.message.text);

        await answerCallbackQuery(callback_query.id);

        if (!AUTHORIZED_USERS.includes(username)) {
          const msg = await sendMessage(chatId, '❌ У вас нет доступа к этой операции');
          setTimeout(() => deleteMessageSafe(chatId, msg.message_id), 30000);
          return res.sendStatus(200);
        }

        if (data === 'accept') {
          await handleAccept(chatId, messageId, username, row, callback_query.message);
        } 
        else if (data.startsWith('assign:')) {
          const buttons = EXECUTORS.map(executor => [{
            text: executor,
            callback_data: `set_executor:${executor}:${row}`
          }]);
          await editMessageSafe(chatId, messageId, 'Выберите исполнителя:', {
            reply_markup: { inline_keyboard: buttons }
          });
        }
        else if (data.startsWith('set_executor:')) {
          await handleSetExecutor(chatId, messageId, data, row, callback_query.message);
        }
        else if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            const msg = await sendMessage(chatId, '❌ Только исполнители могут завершать заявки');
            setTimeout(() => deleteMessageSafe(chatId, msg.message_id), 30000);
            return res.sendStatus(200);
          }

          const requestData = parseRequestMessage(callback_query.message.text || callback_query.message.caption || '');
          const isEmergency = (callback_query.message.text || callback_query.message.caption || '').includes('🚨');

          userStates[chatId] = {
            stage: 'waiting_photo',
            row,
            username,
            messageId,
            originalRequest: requestData,
            isEmergency
          };

          await sendMessage(chatId, '📸 Пришлите фото выполненных работ', {
            reply_to_message_id: messageId
          });
        }
        else if (data.startsWith('wait:')) {
          await sendToGAS({ row, status: 'Ожидает поставки' });
          await editMessageSafe(
            chatId, 
            messageId, 
            `${callback_query.message.text || callback_query.message.caption || ''}\n\n⏳ Ожидает поставки`,
            { reply_markup: { inline_keyboard: getActionButtons(row) } }
          );
        }
        else if (data.startsWith('cancel:')) {
          await sendToGAS({ row, status: 'Отменено' });
          await editMessageSafe(
            chatId, 
            messageId, 
            `${callback_query.message.text || callback_query.message.caption || ''}\n\n❌ Отменена`,
            { reply_markup: { inline_keyboard: getActionButtons(row) } }
          );
        }
      }

      if (body.message && userStates[body.message.chat.id]) {
        const chatId = body.message.chat.id;
        const state = userStates[chatId];
        const msg = body.message;

        if (state.stage === 'waiting_photo' && msg.photo) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          state.photoUrl = `${TELEGRAM_FILE_API}/${fileId}`;
          state.stage = 'waiting_sum';
          await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)', {
            reply_to_message_id: state.messageId
          });
        }
        else if (state.stage === 'waiting_sum' && msg.text) {
          state.sum = msg.text;
          state.stage = 'waiting_comment';
          await sendMessage(chatId, '💬 Введите комментарий', {
            reply_to_message_id: state.messageId
          });
        }
        else if (state.stage === 'waiting_comment' && msg.text) {
          state.comment = msg.text;

          const completionData = {
            row: state.row,
            status: 'Выполнено',
            sum: state.sum,
            comment: state.comment,
            photoUrl: state.photoUrl,
            executor: state.username,
            originalRequest: state.originalRequest,
            isEmergency: state.isEmergency
          };

          await editMessageSafe(
            chatId,
            state.messageId,
            formatCompletionMessage(completionData),
            { 
              disable_web_page_preview: false,
              reply_markup: { inline_keyboard: [] }
            }
          );

          await sendToGAS(completionData);
          delete userStates[chatId];
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(200);
    }
  });
};
