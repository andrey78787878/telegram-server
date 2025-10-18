```javascript
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

function formatCompletionMessage(data) {
  return `
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
    await sendMessage(chatId, `${caption}\n📸 Фото: ${telegramUrl}`, {
      reply_to_message_id: options.reply_to_message_id,
      parse_mode: 'HTML'
    });
    return null;
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
          await sendMessage(chatId, '❌ Ошибка: не найден номер заявки');
          return res.sendStatus(200);
        }

        if (!AUTHORIZED_USERS.includes(username)) {
          const accessDeniedMsg = await sendMessage(chatId, '❌ У вас нет доступа.');
          setTimeout(() => deleteMessageSafe(chatId, accessDeniedMsg?.data?.result?.message_id), 30000);
          return res.sendStatus(200);
        }

        // Обработка кнопки "Принять в работу"
        if (data.startsWith('accept') || data === 'accept') {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут назначать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg?.data?.result?.message_id), 30000);
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
              deadline: return res.sendStatus(200);
        }

        // Обработка отклонения заявки
        if (data.startsWith('reject:')) {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут отклонять заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg?.data?.result?.message_id), 30000);
            return res.sendStatus(200);
          }

          const stateKey = `${chatId}:${row}`;
          const state = userStates[stateKey];

          if (!state || state.stage !== 'pending_confirmation') {
            await sendMessage(chatId, '❌ Заявка уже закрыта или не ожидает подтверждения.');
            return res.sendStatus(200);
          }

          // Удаляем все сервисные сообщения
          if (state.pendingMessageId) {
            await deleteMessageSafe(chatId, state.pendingMessageId);
          }
          if (state.photoMessageId) {
            await deleteMessageSafe(chatId, state.photoMessageId);
          }

          // Отправляем сообщение исполнителю
          const executorId = userStorage.get(state.username);
          if (executorId) {
            await sendMessage(
              executorId,
              `📌 Заявка #${row} требует доработки. Пожалуйста, отправьте новый комментарий.`,
              { parse_mode: 'HTML' }
            );
          } else {
            console.warn(`Executor ID not found for ${state.username}`);
            await sendMessage(chatId, `❌ Не удалось уведомить исполнителя ${state.username}.`);
          }

          // Отправляем сообщение в чат
          await sendMessage(
            chatId,
            `❌ Заявка #${row} отклонена менеджером ${username}. Исполнителю отправлен запрос на доработку.`,
            { reply_to_message_id: state.messageId }
          );

          // Запрашиваем новый комментарий
          const commentMsg = await sendMessage(
            chatId,
            `💬 ${state.username}, напишите новый комментарий для заявки #${row}`,
            { reply_to_message_id: state.messageId }
          );

          // Обновляем состояние
          state.stage = 'waiting_comment';
          state.serviceMessages = [commentMsg?.data?.result?.message_id].filter(Boolean);
          state.userMessages = [];
          state.pendingMessageId = null;
          state.photoMessageId = null;
          state.timestamp = Date.now();

          // Обновляем статус в Google Apps Script
          await sendToGAS({
            row: state.row,
            status: 'Отклонено',
            executor: state.username,
            manager: username,
            message_id: state.messageId,
            pizzeria: state.originalRequest?.pizzeria,
            problem: state.originalRequest?.problem,
            deadline: state.originalRequest?.deadline,
            initiator: state.originalRequest?.initiator,
            phone: state.originalRequest?.phone,
            category: state.originalRequest?.category,
            factDate: new Date().toISOString()
          });

          console.log(`Rejection processed for ${stateKey}, state set to waiting_comment`);
          return res.sendStatus(200);
        }
      }

      // Обработка сообщений (фото, сумма, комментарий)
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

        if (!EXECUTORS.includes(username)) {
          const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут отправлять данные для заявок.');
          setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg?.data?.result?.message_id), 30000);
          return res.sendStatus(200);
        }

        if (state.processedMessageIds.has(messageId)) {
          console.log(`Message ${messageId} already processed for ${stateKey}`);
          return res.sendStatus(200);
        }

        state.processedMessageIds.add(messageId);
        state.userMessages.push(messageId);
        state.timestamp = Date.now();

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

          const diskUrl = await getGoogleDiskLink(row);
          const finalMessage = formatCompletionMessage({
            ...state,
            executor: state.username || '@Unknown'
          });

          // Отправляем фото с подписью сверху
          const photoMsg = await sendPhotoWithCaption(chatId, state.fileId, finalMessage, {
            reply_to_message_id: state.messageId
          });

          // Сохраняем message_id фото
          state.photoMessageId = photoMsg?.data?.result?.message_id;

          // Уведомление о статусе "Ожидает подтверждения" с кнопками "Подтвердить" и "Отклонить"
          const pendingMessage = `🕒 Заявка #${row} ожидает подтверждения менеджера @Andrey_Tkach_Dodo.`;
          const pendingMsg = await sendMessage(chatId, pendingMessage, {
            reply_to_message_id: state.messageId,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Подтвердить', callback_data: `confirm:${row}` },
                  { text: '❌ Отклонить', callback_data: `reject:${row}` }
                ]
              ]
            }
          });

          // Сохраняем message_id уведомления
          state.pendingMessageId = pendingMsg?.data?.result?.message_id;

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
            message_id: state.messageId
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
```
