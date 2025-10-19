const axios = require('axios');
const https = require('https');
axios.defaults.httpsAgent = new https.Agent({ family: 4, keepAlive: true });
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// Права пользователей
const MANAGERS = ['@Andrey_Tkach_Dodo', '@Davr_85', '@EvelinaB87'];
const EXECUTORS = ['@Andrey_Tkach_Dodo', '@olimjon2585', '@Davr_85', '@Oblayor_04_09', '@IkromovichV', '@EvelinaB87'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Маппинг пиццерий к ТУ (массив пользователей)
const PIZZERIA_TO_TU = {
  'Ташкент-1': ['@Andrey_tkach_y', '@AnotherUser'],
  'Ташкент-12': ['@Andrey_tkach_y'],
  'Ташкент-3': ['@Andrey_Tkach_Dodo'],
  'Ташкент-2': ['@Andrey_Tkach_Dodo'],
  'Ташкент-5': ['@Andrey_Tkach_Dodo'],
  'Ташкент-8': ['@Andrey_Tkach_Dodo'],
  'Ташкент-10': ['@Andrey_Tkach_Dodo'],
  'Ташкент-14': ['@Andrey_Tkach_Dodo'],
  'Ташкент-4': ['@Andrey_tkach_y', '@AnotherUser'],
  'Ташкент-7': ['@Andrey_tkach_y'],
  'Ташкент-6': ['@Andrey_tkach_y'],
  'Ташкент-9': ['@NewUser', '@AnotherUser']
};

// Хранилище user_id и времени последней ошибки
const userStorage = new Map();
const errorMessageCooldown = new Map();

// Вспомогательные функции
function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!parts) {
    console.error(`Invalid date format: ${dateStr}`);
    return null;
  }
  return new Date(parseInt(parts[3]), parseInt(parts[2]) - 1, parseInt(parts[1]));
}

function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  return parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : null;
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
    if (line.includes('Классификация:')) result.category = line.split(':')[1].trim();
    if (line.includes('Категория:')) result.category = line.split(':')[1].trim();
    if (line.includes('Проблема:')) result.problem = line.split(':')[1].trim();
    if (line.includes('Инициатор:')) result.initiator = line.split(':')[1].trim();
    if (line.includes('Телефон:')) result.phone = line.split(':')[1].trim();
    if (line.includes('Срок:')) result.deadline = line.split(':')[1].trim();
  });
  return result;
}

function calculateDelayDays(deadline) {
  if (!deadline) return 0;
  try {
    const deadlineDate = parseDate(deadline);
    if (!deadlineDate || isNaN(deadlineDate)) {
      throw new Error(`Invalid date format: ${deadline}`);
    }
    const today = new Date();
    const diffTime = today - deadlineDate;
    return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  } catch (e) {
    console.error('Error calculating delay:', e);
    return 0;
  }
}

function formatCompletionMessage(data, confirmerUsername, isTU) {
  const role = isTU ? 'ТУ' : 'менеджером';
  return `
✅ Заявка #${data.row} ${data.isEmergency ? '🚨 (АВАРИЙНАЯ)' : ''} закрыта и подтверждена ${role} ${confirmerUsername || '@Unknown'}
💬 Комментарий: ${data.comment || 'нет комментария'}
💰 Сумма: ${data.sum || '0'} сум
👤 Исполнитель: ${data.executor || '@Unknown'}
${data.delay > 0 ? `🔴 Просрочка: ${data.delay} дн.` : ''}
━━━━━━━━━━━━
🏢 Пиццерия: ${data.originalRequest?.pizzeria || 'не указано'}
🔧 Проблема: ${data.originalRequest?.problem || 'не указано'}
  `.trim();
}

async function sendMessage(chatId, text, options = {}) {
  if (!text) {
    console.error('Attempted to send empty message');
    return null;
  }
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    try {
      const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      });
      console.log(`Message sent to ${chatId}: ${text.substring(0, 50)}...`);
      if (text.includes('❌') || text.includes('⏰')) {
        setTimeout(() => deleteMessageSafe(chatId, response?.data?.result?.message_id), 20000);
      }
      return response;
    } catch (error) {
      if (error.response?.data?.error_code === 429) {
        const retryAfter = error.response.data.parameters.retry_after || 10;
        console.warn(`Too Many Requests, retrying after ${retryAfter}s`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        attempts++;
        continue;
      }
      console.error('Send message error:', error.response?.data || error.message);
      throw error;
    }
  }
  throw new Error(`Failed to send message after ${maxAttempts} attempts`);
}

async function sendPhotoWithCaption(chatId, fileId, caption, options = {}) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendPhoto`, {
      chat_id: chatId,
      photo: fileId,
      caption,
      parse_mode: 'HTML',
      show_caption_above_media: true,
      ...options
    });
    console.log(`Photo sent to ${chatId}: ${caption.substring(0, 50)}...`);
    return response;
  } catch (error) {
    console.error('Send photo error:', error.response?.data || error.message);
    const telegramUrl = await getTelegramFileUrl(fileId);
    const response = await sendMessage(chatId, `${caption}\n📸 Фото: ${telegramUrl}`, {
      reply_to_message_id: options.reply_to_message_id,
      parse_mode: 'HTML'
    });
    return response;
  }
}

async function editMessageSafe(chatId, messageId, text, options = {}) {
  if (!text) {
    console.error('Attempted to edit message with empty text');
    return null;
  }
  try {
    const response = await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options
    });
    console.log(`Message edited in ${chatId}, message_id: ${messageId}`);
    return response;
  } catch (error) {
    if (error.response?.data?.description?.includes('no text in the message') || 
        error.response?.data?.description?.includes('message to edit not found')) {
      console.log(`Editing failed, sending new message to ${chatId}`);
      return await sendMessage(chatId, text, options);
    }
    console.error('Edit message error:', error.response?.data || error.message);
    throw error;
  }
}

async function sendButtonsWithRetry(chatId, messageId, buttons, fallbackText) {
  if (!fallbackText) {
    console.error('Fallback text is empty in sendButtonsWithRetry');
    return null;
  }
  try {
    const response = await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons }
    });
    console.log(`Buttons updated for message ${messageId} in ${chatId}`);
    return response;
  } catch (error) {
    if (error.response?.data?.description?.includes('not modified')) {
      console.log(`Buttons not modified for message ${messageId}`);
      return { ok: true };
    }
    console.log(`Button update failed, sending new message with buttons to ${chatId}`);
    return await sendMessage(chatId, fallbackText, {
      reply_markup: { inline_keyboard: buttons }
    });
  }
}

async function deleteMessageSafe(chatId, messageId) {
  if (!messageId) {
    console.log('No messageId provided for deletion');
    return null;
  }
  try {
    const response = await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
    console.log(`Message ${messageId} deleted in ${chatId}`);
    return response;
  } catch (error) {
    console.error('Delete message error:', error.response?.data || error.message);
    return null;
  }
}

async function getTelegramFileUrl(fileId) {
  try {
    const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const url = `${TELEGRAM_FILE_API}/${data.result.file_path}`;
    console.log(`File URL retrieved: ${url}`);
    return url;
  } catch (error) {
    console.error('Get file URL error:', error.response?.data || error.message);
    return null;
  }
}

async function sendToGAS(data) {
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    try {
      console.log('Sending to GAS:', JSON.stringify(data, null, 2));
      const response = await axios.post(GAS_WEB_APP_URL, data);
      console.log('Data sent to GAS:', response.status, 'Response:', JSON.stringify(response.data));
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data?.retry_after || 10;
        console.warn(`Too Many Requests to GAS, retrying after ${retryAfter}s`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        attempts++;
        continue;
      }
      console.error('Error sending to GAS:', error.message, 'Response:', error.response?.data);
      throw error;
    }
  }
  throw new Error(`Failed to send to GAS after ${maxAttempts} attempts`);
}

async function getGoogleDiskLink(row) {
  try {
    const res = await axios.post(`${GAS_WEB_APP_URL}?getDiskLink=true`, { row });
    const diskLink = res.data.diskLink || null;
    console.log(`Google Disk link for row ${row}: ${diskLink}`);
    return diskLink;
  } catch (error) {
    console.error('Get Google Disk link error:', error.response?.data || error.message);
    return null;
  }
}

// Хранилище состояний с уникальными ключами
const userStates = {};

module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      // Сохраняем user_id
      if (body.message?.from) {
        const user = body.message.from;
        if (user.username) {
          userStorage.set(`@${user.username}`, user.id);
          console.log(`Saved user_id for ${user.username}: ${user.id}`);
        }
      }

      // Обработка callback_query
      if (body.callback_query) {
        const { callback_query } = body;
        const user = callback_query.from;
        if (user.username) {
          userStorage.set(`@${user.username}`, user.id);
        }

        const msg = callback_query.message;
        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const username = user.username ? `@${user.username}` : null;
        const data = callback_query.data;

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callback_query.id
        }).catch(e => console.error('Answer callback error:', e));

        const row = extractRowFromCallbackData(data) || extractRowFromMessage(msg.text || msg.caption);
        if (!row || isNaN(row)) {
          console.error('Не удалось извлечь номер заявки');
          const errorMsg = await sendMessage(chatId, '❌ Ошибка: не найден номер заявки');
          setTimeout(() => deleteMessageSafe(chatId, errorMsg?.data?.result?.message_id), 20000);
          return res.sendStatus(200);
        }

        if (!AUTHORIZED_USERS.includes(username)) {
          const accessDeniedMsg = await sendMessage(chatId, '❌ У вас нет доступа.');
          setTimeout(() => deleteMessageSafe(chatId, accessDeniedMsg?.data?.result?.message_id), 20000);
          return res.sendStatus(200);
        }

        // Обработка кнопки "Принять в работу"
        if (data.startsWith('accept') || data === 'accept') {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут назначать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg?.data?.result?.message_id), 20000);
            return res.sendStatus(200);
          }

          const isEmergency = msg.text?.includes('🚨') || msg.caption?.includes('🚨');
          const requestData = parseRequestMessage(msg.text || msg.caption);

          if (isEmergency) {
            for (const manager of MANAGERS) {
              const managerId = userStorage.get(manager);
              if (managerId && managerId !== user.id) {
                await sendMessage(
                  managerId,
                  `🚨 МЕНЕДЖЕР ${username} ПРИНЯЛ АВАРИЙНУЮ ЗАЯВКУ #${row}\n\n` +
                  `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                  `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                  `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                  `‼️ ТРЕБУЕТСЯ КОНТРОЛЬ!`,
                  { disable_notification: false }
                ).catch(e => console.error(`Error sending to ${manager}:`, e));
              }
            }

            const buttons = EXECUTORS.map(e => [
              { text: e, callback_data: `executor:${e}:${row}` }
            ]);

            const chooseExecutorMsg = await sendMessage(chatId, `🚨 АВАРИЙНАЯ ЗАЯВКА - выберите исполнителя #${row}:`, {
              reply_to_message_id: messageId
            });

            setTimeout(async () => {
              try {
                await deleteMessageSafe(chatId, chooseExecutorMsg?.data?.result?.message_id);
              } catch (e) {
                console.error('Error deleting choose executor message:', e);
              }
            }, 60000);

            await sendButtonsWithRetry(chatId, messageId, buttons, `Выберите исполнителя для аварийной заявки #${row}:`);

            await sendToGAS({
              row,
              status: 'Аварийная',
              message_id: messageId,
              isEmergency: true,
              pizzeria: requestData?.pizzeria,
              problem: requestData?.problem,
              deadline: requestData?.deadline,
              initiator: requestData?.initiator,
              phone: requestData?.phone,
              category: requestData?.category,
              manager: username,
              timestamp: new Date().toISOString()
            });

            return res.sendStatus(200);
          }

          const buttons = EXECUTORS.map(e => [
            { text: e, callback_data: `executor:${e}:${row}` }
          ]);

          const chooseExecutorMsg = await sendMessage(chatId, `👷 Выберите исполнителя для заявки #${row}:`, {
            reply_to_message_id: messageId
          });

          setTimeout(async () => {
            try {
              await deleteMessageSafe(chatId, chooseExecutorMsg?.data?.result?.message_id);
            } catch (e) {
              console.error('Error deleting choose executor message:', e);
            }
          }, 60000);

          await sendButtonsWithRetry(chatId, messageId, buttons, `Выберите исполнителя для заявки #${row}:`);

          await sendToGAS({
            row,
            status: 'Принята в работу',
            message_id: messageId,
            pizzeria: requestData?.pizzeria,
            problem: requestData?.problem,
            deadline: requestData?.deadline,
            initiator: requestData?.initiator,
            phone: requestData?.phone,
            category: requestData?.category,
            manager: username,
            timestamp: new Date().toISOString()
          });

          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя
        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
          const requestData = parseRequestMessage(msg.text || msg.caption);

          if (msg.reply_to_message) {
            await deleteMessageSafe(chatId, msg.reply_to_message.message_id);
          }

          const actionButtons = [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '⏳ Ожидает', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` }
            ]
          ];

          await sendButtonsWithRetry(chatId, messageId, actionButtons, `Выберите действие для заявки #${row}:`);

          const executorMsg = await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          const executorId = userStorage.get(executorUsername);
          if (executorId) {
            await sendMessage(
              executorId,
              `📌 Вам назначена заявка #${row}\n\n` +
              `🍕 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
              `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
              `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
              `⚠️ Приступайте к выполнению`,
              { parse_mode: 'HTML' }
            ).catch(e => console.error('Error sending to executor:', e));
          } else {
            console.warn('❗ Не найден executorId для', executorUsername);
          }

          await sendToGAS({
            row,
            status: 'В работе',
            executor: executorUsername,
            message_id: messageId,
            pizzeria: requestData?.pizzeria,
            problem: requestData?.problem,
            deadline: requestData?.deadline,
            initiator: requestData?.initiator,
            phone: requestData?.phone,
            category: requestData?.category,
            manager: username,
            timestamp: new Date().toISOString()
          });

          return res.sendStatus(200);
        }

        // Обработка завершения заявки
        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут завершать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg?.data?.result?.message_id), 20000);
            return res.sendStatus(200);
          }

          const stateKey = `${chatId}:${row}`;
          if (userStates[stateKey] && userStates[stateKey].stage === 'waiting_photo') {
            console.log(`Already waiting for photo for ${stateKey}, ignoring duplicate done`);
            return res.sendStatus(200);
          }

          const isEmergency = msg.text?.includes('🚨') || msg.caption?.includes('🚨');

          console.log(`Starting completion process for row ${row}, stateKey: ${stateKey}`);

          if (userStates[stateKey]) {
            console.log(`Clearing previous state for ${stateKey}`);
            delete userStates[stateKey];
          }

          const photoMsg = await sendMessage(
            chatId,
            `📸 Пришлите фото выполненных работ для заявки #${row}`,
            { reply_to_message_id: messageId }
          );

          userStates[stateKey] = {
            stage: 'waiting_photo',
            row,
            username,
            messageId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [photoMsg?.data?.result?.message_id].filter(Boolean),
            userMessages: [],
            isEmergency,
            processedMessageIds: new Set(),
            timestamp: Date.now()
          };

          console.log(`State set to waiting_photo for ${stateKey}`);

          setTimeout(async () => {
            try {
              const currentState = userStates[stateKey];
              if (currentState?.stage === 'waiting_photo') {
                await deleteMessageSafe(chatId, currentState.serviceMessages[0]);
                for (const userMsgId of currentState.userMessages) {
                  await deleteMessageSafe(chatId, userMsgId);
                }
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания фото истекло.', { reply_to_message_id: currentState.messageId });
                console.log(`Timeout triggered for ${stateKey} (waiting_photo), state cleared`);
              }
            } catch (e) {
              console.error(`Error handling photo timeout for ${stateKey}:`, e);
            }
          }, 60000);

          return res.sendStatus(200);
        }

        // Обработка подтверждения закрытия
        if (data.startsWith('confirm:')) {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут подтверждать закрытие заявок.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg?.data?.result?.message_id), 20000);
            return res.sendStatus(200);
          }

          const stateKey = `${chatId}:${row}`;
          const state = userStates[stateKey];

          if (!state || state.stage !== 'pending_confirmation') {
            const errorMsg = await sendMessage(chatId, '❌ Заявка уже закрыта или не ожидает подтверждения.');
            setTimeout(() => deleteMessageSafe(chatId, errorMsg?.data?.result?.message_id), 20000);
            return res.sendStatus(200);
          }

          // Определяем ТУ по пиццерии
          const pizzeria = state.originalRequest?.pizzeria;
          const tuUsernames = pizzeria ? PIZZERIA_TO_TU[pizzeria] || ['@Unknown'] : ['@Unknown'];
          const isTU = tuUsernames.includes(username);
          const confirmerUsername = username;

          // Удаляем промежуточные сообщения
          if (state.photoMessageId) {
            await deleteMessageSafe(chatId, state.photoMessageId);
          }
          if (state.pendingMessageId) {
            await deleteMessageSafe(chatId, state.pendingMessageId);
          }

          // Удаляем кнопки из материнской заявки
          await sendButtonsWithRetry(chatId, state.messageId, [], `Заявка #${row} закрыта`);

          // Отправляем финальное сообщение с фото
          const finalMessage = formatCompletionMessage({
            ...state,
            executor: state.username || '@Unknown'
          }, confirmerUsername, isTU);

          const photoResponse = await sendPhotoWithCaption(chatId, state.fileId, finalMessage, {
            reply_to_message_id: state.messageId
          });

          // Уведомляем всех ТУ о подтверждении
          for (const tu of tuUsernames) {
            if (tu !== username) {
              const tuId = userStorage.get(tu);
              if (tuId) {
                await sendMessage(
                  tuId,
                  `📌 Заявка #${row} подтверждена ${isTU ? 'ТУ' : 'менеджером'} ${confirmerUsername}\n\n` +
                  `🍕 Пиццерия: ${state.originalRequest?.pizzeria || 'не указано'}\n` +
                  `🔧 Проблема: ${state.originalRequest?.problem || 'не указано'}\n` +
                  `💬 Комментарий: ${state.comment || 'нет комментария'}\n` +
                  `💰 Сумма: ${state.sum || '0'} сум\n` +
                  `👤 Исполнитель: ${state.username || '@Unknown'}\n` +
                  `📸 Фото: ${state.photoUrl || 'не указано'}`,
                  { parse_mode: 'HTML' }
                ).catch(e => console.error(`Error sending to TU ${tu}:`, e));
              } else {
                console.warn(`TU ID not found for ${tu}`);
              }
            }
          }

          // Обновляем статус в Google Apps Script
          await sendToGAS({
            row: state.row,
            status: 'Выполнено',
            executor: state.username,
            confirmer: confirmerUsername,
            isTU: isTU,
            message_id: state.messageId,
            pizzeria: state.originalRequest?.pizzeria,
            problem: state.originalRequest?.problem,
            deadline: state.originalRequest?.deadline,
            initiator: state.originalRequest?.initiator,
            phone: state.originalRequest?.phone,
            category: state.originalRequest?.category,
            factDate: new Date().toISOString()
          });

          console.log(`Completion confirmed for ${stateKey} by ${confirmerUsername}, state cleared`);
          delete userStates[stateKey];

          return res.sendStatus(200);
        }

        // Обработка возврата на доработку
        if (data.startsWith('return:')) {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут возвращать заявки на доработку.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg?.data?.result?.message_id), 20000);
            return res.sendStatus(200);
          }

          const stateKey = `${chatId}:${row}`;
          const state = userStates[stateKey];

          if (!state || state.stage !== 'pending_confirmation') {
            const errorMsg = await sendMessage(chatId, '❌ Заявка уже закрыта или не ожидает подтверждения.');
            setTimeout(() => deleteMessageSafe(chatId, errorMsg?.data?.result?.message_id), 20000);
            return res.sendStatus(200);
          }

          const reasonMsg = await sendMessage(
            chatId,
            `📝 Укажите причину возврата заявки #${row} на доработку`,
            { reply_to_message_id: messageId }
          );

          state.stage = 'waiting_return_reason';
          state.serviceMessages = [reasonMsg?.data?.result?.message_id].filter(Boolean);
          state.userMessages = [];
          state.manager = username;
          console.log(`State updated to waiting_return_reason for ${stateKey}`);

          setTimeout(async () => {
            try {
              const currentState = userStates[stateKey];
              if (currentState?.stage === 'waiting_return_reason') {
                await deleteMessageSafe(chatId, currentState.serviceMessages[0]);
                for (const userMsgId of currentState.userMessages) {
                  await deleteMessageSafe(chatId, userMsgId);
                }
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания причины возврата истекло.', { reply_to_message_id: currentState.messageId });
                console.log(`Timeout triggered for ${stateKey} (waiting_return_reason), state cleared`);
              }
            } catch (e) {
              console.error(`Error handling return reason timeout for ${stateKey}:`, e);
            }
          }, 60000);

          return res.sendStatus(200);
        }

        // Обработка отмены заявки
        if (data.startsWith('cancel:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут отменять заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg?.data?.result?.message_id), 20000);
            return res.sendStatus(200);
          }

          await sendMessage(chatId, '🚫 Заявка отменена', { 
            reply_to_message_id: messageId 
          });

          const requestData = parseRequestMessage(msg.text || msg.caption);

          await sendToGAS({ 
            row: parseInt(data.split(':')[1]), 
            status: 'Отменено',
            executor: username,
            message_id: messageId,
            pizzeria: requestData?.pizzeria,
            problem: requestData?.problem,
            deadline: requestData?.deadline,
            initiator: requestData?.initiator,
            phone: requestData?.phone,
            category: requestData?.category,
            timestamp: new Date().toISOString()
          });

          await sendButtonsWithRetry(chatId, messageId, [], `Заявка #${row} отменена`);

          return res.sendStatus(200);
        }
      }

      // Обработка сообщений (фото, сумма, комментарий, причина возврата)
      if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const user = msg.from;
        const username = user.username ? `@${user.username}` : null;
        const text = msg.text || msg.caption;

        console.log(`Processing message in chat ${chatId}, messageId: ${messageId}, hasPhoto: ${!!msg.photo}, hasDocument: ${!!msg.document}, replyToMessageId: ${msg.reply_to_message?.message_id || 'none'}, text: ${text}`);

        // Поиск состояния
        let stateKey = null;
        let state = null;
        let row = null;

        if (msg.reply_to_message && msg.reply_to_message.text) {
          row = extractRowFromMessage(msg.reply_to_message.text);
        }
        row = row || extractRowFromMessage(text);

        if (msg.reply_to_message && msg.reply_to_message.message_id) {
          for (const key of Object.keys(userStates)) {
            if (userStates[key].serviceMessages.includes(msg.reply_to_message.message_id) && userStates[key].username === username) {
              stateKey = key;
              state = userStates[key];
              row = state.row;
              break;
            }
          }
        }

        if (!stateKey && row) {
          const possibleStateKey = `${chatId}:${row}`;
          if (userStates[possibleStateKey] && userStates[possibleStateKey].username === username) {
            stateKey = possibleStateKey;
            state = userStates[possibleStateKey];
          }
        }

        if (!stateKey) {
          const userStateKeys = Object.keys(userStates).filter(key => userStates[key].username === username);
          if (userStateKeys.length > 0) {
            const latestStateKey = userStateKeys.sort((a, b) => {
              const timeA = userStates[a].timestamp || 0;
              const timeB = userStates[b].timestamp || 0;
              return timeB - timeA;
            })[0];
            stateKey = latestStateKey;
            state = userStates[latestStateKey];
            row = state.row;
          }
        }

        console.log(`Resolved state: stateKey: ${stateKey}, row: ${row}, state: ${JSON.stringify(state)}`);

        if (!state || !row) {
          console.log(`No state or row found for message in chat ${chatId}, text: ${text}, replyToMessageId: ${msg.reply_to_message?.message_id || 'none'}`);
          return res.sendStatus(200);
        }

        if (state.stage === 'waiting_return_reason' && !MANAGERS.includes(username)) {
          const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут указывать причину возврата.');
          setTimeout(() => deleteMessageSafe(chatId, notManagerMsg?.data?.result?.message_id), 20000);
          return res.sendStatus(200);
        }

        if (!EXECUTORS.includes(username) && state.stage !== 'waiting_return_reason') {
          const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут отправлять данные для заявок.');
          setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg?.data?.result?.message_id), 20000);
          return res.sendStatus(200);
        }

        if (state.processedMessageIds.has(messageId)) {
          console.log(`Message ${messageId} already processed for ${stateKey}`);
          return res.sendStatus(200);
        }

        state.processedMessageIds.add(messageId);
        state.userMessages.push(messageId);
        state.timestamp = Date.now();

        // Обработка причины возврата
        if (state.stage === 'waiting_return_reason' && text) {
          console.log(`Return reason received for ${stateKey}: ${text}`);
          state.returnReason = text;

          for (const serviceMsgId of state.serviceMessages) {
            await deleteMessageSafe(chatId, serviceMsgId);
          }
          for (const userMsgId of state.userMessages) {
            await deleteMessageSafe(chatId, userMsgId);
          }
          if (state.pendingMessageId) {
            await deleteMessageSafe(chatId, state.pendingMessageId);
          }
          if (state.photoMessageId) {
            await deleteMessageSafe(chatId, state.photoMessageId);
          }

          state.serviceMessages = [];
          state.userMessages = [];

          // Определяем ТУ по пиццерии
          const pizzeria = state.originalRequest?.pizzeria;
          const tuUsernames = pizzeria ? PIZZERIA_TO_TU[pizzeria] || ['@Unknown'] : ['@Unknown'];
          const isTU = tuUsernames.includes(username);
          const confirmerUsername = username;

          // Уведомляем исполнителя о возврате
          const executorId = userStorage.get(state.username);
          if (executorId) {
            await sendMessage(
              executorId,
              `📌 Заявка #${row} возвращена на доработку ${isTU ? 'ТУ' : 'менеджером'} ${confirmerUsername}\n\n` +
              `📝 Причина: ${text}\n\n` +
              `Устраните замечания к заявке и согласуйте еще раз.`,
              { parse_mode: 'HTML' }
            ).catch(e => console.error(`Error sending return notification to ${state.username}:`, e));
          } else {
            console.warn(`Executor ID not found for ${state.username}`);
          }

          // Уведомляем только ТУ из маппинга
          for (const tu of tuUsernames) {
            if (tu !== username) {
              const tuId = userStorage.get(tu);
              if (tuId) {
                await sendMessage(
                  tuId,
                  `📌 Заявка #${row} возвращена на доработку ${isTU ? 'ТУ' : 'менеджером'} ${confirmerUsername}\n\n` +
                  `📝 Причина: ${text}\n` +
                  `👤 Исполнитель: ${state.username || '@Unknown'}\n\n` +
                  `⚠️ Контролируйте выполнение`,
                  { parse_mode: 'HTML' }
                ).catch(e => console.error(`Error sending to TU ${tu}:`, e));
              } else {
                console.warn(`TU ID not found for ${tu}`);
              }
            }
          }

          // Уведомляем в чате
          const returnMsg = await sendMessage(
            chatId,
            `📌 Заявка #${row} возвращена на доработку ${isTU ? 'ТУ' : 'менеджером'} ${confirmerUsername}\n` +
            `📝 Причина: ${text}`,
            { reply_to_message_id: state.messageId }
          );

          // Запрашиваем новое выполнение
          const retryMsg = await sendMessage(
            chatId,
            `📋 Устраните замечания к заявке #${row} и согласуйте еще раз.`,
            { reply_to_message_id: state.messageId }
          );

          // Обновляем статус в GAS
          await sendToGAS({
            row: state.row,
            status: 'Возвращена на доработку',
            executor: state.username,
            confirmer: confirmerUsername,
            isTU: isTU,
            returnReason: text,
            message_id: state.messageId,
            pizzeria: state.originalRequest?.pizzeria,
            problem: state.originalRequest?.problem,
            deadline: state.originalRequest?.deadline,
            initiator: state.originalRequest?.initiator,
            phone: state.originalRequest?.phone,
            category: state.originalRequest?.category,
            timestamp: new Date().toISOString()
          });

          // Очищаем старые данные
          delete state.fileId;
          delete state.photoUrl;
          delete state.photoDirectUrl;
          delete state.sum;
          delete state.comment;
          delete state.returnReason;
          delete state.photoMessageId;
          delete state.pendingMessageId;

          state.stage = 'waiting_photo';
          state.serviceMessages = [retryMsg?.data?.result?.message_id].filter(Boolean);
          console.log(`State updated to waiting_photo for ${stateKey} after return`);

          setTimeout(async () => {
            try {
              const currentState = userStates[stateKey];
              if (currentState?.stage === 'waiting_photo') {
                await deleteMessageSafe(chatId, currentState.serviceMessages[0]);
                for (const userMsgId of currentState.userMessages) {
                  await deleteMessageSafe(chatId, userMsgId);
                }
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания устранения замечаний истекло.', { reply_to_message_id: currentState.messageId });
                console.log(`Timeout triggered for ${stateKey} (waiting_photo), state cleared`);
              }
            } catch (e) {
              console.error(`Error handling photo timeout for ${stateKey}:`, e);
            }
          }, 60000);

          return res.sendStatus(200);
        }

        // Обработка фото
        if (state.stage === 'waiting_photo' && (msg.photo || msg.document)) {
          console.log(`Photo received for ${stateKey}, fileId: ${msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id}`);
          const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
          const telegramUrl = await getTelegramFileUrl(fileId);

          for (const serviceMsgId of state.serviceMessages) {
            await deleteMessageSafe(chatId, serviceMsgId);
          }

          state.serviceMessages = [];
          state.fileId = fileId;
          state.photoUrl = telegramUrl;
          state.photoDirectUrl = telegramUrl;

          const sumMsg = await sendMessage(
            chatId,
            `💰 Укажите сумму работ (в сумах) для заявки #${row}`,
            { reply_to_message_id: state.messageId }
          );

          state.stage = 'waiting_sum';
          state.serviceMessages.push(sumMsg?.data?.result?.message_id);
          console.log(`State updated to waiting_sum for ${stateKey}, sumMsg ID: ${sumMsg?.data?.result?.message_id}`);
          return res.sendStatus(200);
        }

        // Обработка суммы
        if (state.stage === 'waiting_sum' && text && !isNaN(parseFloat(text))) {
          console.log(`Sum received for ${stateKey}: ${text}`);
          state.sum = text;

          for (const serviceMsgId of state.serviceMessages) {
            await deleteMessageSafe(chatId, serviceMsgId);
          }
          for (const userMsgId of state.userMessages) {
            await deleteMessageSafe(chatId, userMsgId);
          }

          state.serviceMessages = [];
          state.userMessages = [];

          const commentMsg = await sendMessage(
            chatId,
            `💬 Напишите комментарий для заявки #${row}`,
            { reply_to_message_id: state.messageId }
          );

          state.stage = 'waiting_comment';
          state.serviceMessages.push(commentMsg?.data?.result?.message_id);
          console.log(`State updated to waiting_comment for ${stateKey}, commentMsg ID: ${commentMsg?.data?.result?.message_id}`);
          return res.sendStatus(200);
        }

        // Обработка комментария
        if (state.stage === 'waiting_comment' && text) {
          console.log(`Comment received for ${stateKey}: ${text}`);
          state.comment = text;

          for (const serviceMsgId of state.serviceMessages) {
            await deleteMessageSafe(chatId, serviceMsgId);
          }
          for (const userMsgId of state.userMessages) {
            await deleteMessageSafe(chatId, userMsgId);
          }

          // Определяем ТУ по пиццерии
          const pizzeria = state.originalRequest?.pizzeria;
          const tuUsernames = pizzeria ? PIZZERIA_TO_TU[pizzeria] || ['@Unknown'] : ['@Unknown'];
          const tuUsername = tuUsernames[0];

          const diskUrl = await getGoogleDiskLink(row);
          const preliminaryMessage = formatCompletionMessage({
            ...state,
            executor: state.username || '@Unknown'
          }, tuUsername, true);

          // Отправляем фото с предварительной подписью
          const photoResponse = await sendPhotoWithCaption(chatId, state.fileId, preliminaryMessage, {
            reply_to_message_id: state.messageId
          });

          // Сохраняем ID сообщения с фото
          state.photoMessageId = photoResponse?.data?.result?.message_id;

          // Уведомление о статусе "Ожидает подтверждения" с кнопками
          const pendingMessage = `🕒 Заявка #${row} ожидает подтверждения ТУ ${tuUsernames.join(', ')}.`;
          const pendingMsgResponse = await sendMessage(chatId, pendingMessage, {
            reply_to_message_id: state.messageId,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Подтвердить закрытие', callback_data: `confirm:${row}` },
                  { text: '🔄 Вернуть на доработку', callback_data: `return:${row}` }
                ]
              ]
            }
          });

          state.pendingMessageId = pendingMsgResponse?.data?.result?.message_id;

          // Уведомляем всех ТУ
          for (const tu of tuUsernames) {
            const tuId = userStorage.get(tu);
            if (tuId) {
              await sendMessage(
                tuId,
                `📌 Заявка #${row} ожидает вашего подтверждения\n\n` +
                `🍕 Пиццерия: ${state.originalRequest?.pizzeria || 'не указано'}\n` +
                `🔧 Проблема: ${state.originalRequest?.problem || 'не указано'}\n` +
                `💬 Комментарий: ${state.comment || 'нет комментария'}\n` +
                `💰 Сумма: ${state.sum || '0'} сум\n` +
                `👤 Исполнитель: ${state.username || '@Unknown'}\n` +
                `📸 Фото: ${state.photoUrl || 'не указано'}\n\n` +
                `⚠️ Подтвердите или верните на доработку`,
                { parse_mode: 'HTML' }
              ).catch(e => console.error(`Error sending to TU ${tu}:`, e));
            } else {
              console.warn(`TU ID not found for ${tu}`);
            }
          }

          const completionData = {
            row: state.row,
            sum: state.sum,
            comment: state.comment,
            photoUrl: state.photoUrl,
            executor: state.username || '@Unknown',
            originalRequest: state.originalRequest,
            delay: calculateDelayDays(state.originalRequest?.deadline),
            status: 'Ожидает подтверждения',
            isEmergency: state.isEmergency,
            pizzeria: state.originalRequest?.pizzeria,
            problem: state.originalRequest?.problem,
            deadline: state.originalRequest?.deadline,
            initiator: state.originalRequest?.initiator,
            phone: state.originalRequest?.phone,
            category: state.originalRequest?.category,
            factDate: new Date().toISOString(),
            message_id: state.messageId,
            tu: tuUsernames.join(', ')
          };

          await sendToGAS(completionData);

          state.stage = 'pending_confirmation';
          state.serviceMessages = [];
          state.userMessages = [];
          console.log(`State updated to pending_confirmation for ${stateKey}`);

          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(500);
    }
  });
};
