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
const EXECUTORS = ['@Andrey_Tkach_Dodo', '@Olim19', '@Davr_85', '@Oblayor_04_09', '@IkromovichV', '@EvelinaB87'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Хранилище user_id и времени последней ошибки
const userStorage = new Map();
const errorMessageCooldown = new Map(); // Для ограничения сообщений об ошибке

// Вспомогательные функции
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
    const deadlineDate = new Date(deadline);
    const today = new Date();
    const diffTime = today - deadlineDate;
    return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  } catch (e) {
    console.error('Error calculating delay:', e);
    return 0;
  }
}

function formatCompletionMessage(data, diskUrl = null) {
  const photoLink = diskUrl ? diskUrl : (data.photoUrl ? data.photoUrl : null);
  return `
✅ Заявка #${data.row} ${data.isEmergency ? '🚨 (АВАРИЙНАЯ)' : ''} закрыта
${photoLink ? `\n📸 ${photoLink}\n` : ''}
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

async function editMessageSafe(chatId, messageId, text, options = {}) {
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
  try {
    console.log('Sending to GAS:', data);
    const response = await axios.post(GAS_WEB_APP_URL, data);
    console.log('Data sent to GAS:', response.status);
    return response.data;
  } catch (error) {
    console.error('Error sending to GAS:', error.message);
    throw error;
  }
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

        // Обработка новых сообщений для дублирования аварийных заявок
        const msg = body.message;
        const text = msg.text || msg.caption;
        if (text && (text.includes('🚨') || text.includes('АВАРИЙНАЯ'))) {
          const requestData = parseRequestMessage(text);
          const row = extractRowFromMessage(text);
          if (row) {
            console.log(`Processing emergency request #${row}`);
            for (const manager of MANAGERS) {
              const managerId = userStorage.get(manager);
              if (managerId) {
                await sendMessage(
                  managerId,
                  `🚨 ПОСТУПИЛА АВАРИЙНАЯ ЗАЯВКА #${row}\n\n` +
                  `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                  `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                  `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                  `‼️ ТРЕБУЕТСЯ ВАШЕ ВНИМАНИЕ!`,
                  { disable_notification: false }
                ).catch(e => console.error(`Error sending to ${manager}:`, e));
              }
            }
          }
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
          setTimeout(() => deleteMessageSafe(chatId, accessDeniedMsg.data.result.message_id), 30000);
          return res.sendStatus(200);
        }

        // Обработка кнопки "Принять в работу"
        if (data.startsWith('accept') || data === 'accept') {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут назначать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg.data.result.message_id), 30000);
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
                await deleteMessageSafe(chatId, chooseExecutorMsg.data.result.message_id);
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
              await deleteMessageSafe(chatId, chooseExecutorMsg.data.result.message_id);
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

          await sendMessage(
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
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          const stateKey = `${chatId}:${row}`;
          const isEmergency = msg.text?.includes('🚨') || msg.caption?.includes('🚨');

          console.log(`Starting completion process for row ${row}, stateKey: ${stateKey}`);

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
            serviceMessages: [photoMsg.data.result.message_id],
            isEmergency
          };

          console.log(`State set to waiting_photo for ${stateKey}`);

          setTimeout(async () => {
            try {
              if (userStates[stateKey]?.stage === 'waiting_photo') {
                await deleteMessageSafe(chatId, photoMsg.data.result.message_id);
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания фото истекло.', { reply_to_message_id: messageId });
                console.log(`Timeout triggered for ${stateKey} (waiting_photo), state cleared`);
              }
            } catch (e) {
              console.error(`Error handling photo timeout for ${stateKey}:`, e);
            }
          }, 60000); // 1 минута

          return res.sendStatus(200);
        }

        // Обработка отмены заявки
        if (data.startsWith('cancel:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут отменять заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
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

          await sendButtonsWithRetry(chatId, messageId, []);

          return res.sendStatus(200);
        }
      }

      // Обработка обычных сообщений
      if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const text = msg.text || msg.caption;
        const messageId = msg.message_id;
        const username = msg.from.username ? `@${msg.from.username}` : null;

        // Поиск последнего состояния для данного чата и пользователя
        let stateKey = null;
        let state = null;
        let row = null;

        for (const key of Object.keys(userStates)) {
          if (key.startsWith(`${chatId}:`) && userStates[key].username === username) {
            stateKey = key;
            state = userStates[key];
            row = state.row;
            break;
          }
        }

        console.log(`Processing message in chat ${chatId}, row: ${row}, stateKey: ${stateKey}, state: ${JSON.stringify(state)}`);

        // Обработка фото
        if (state?.stage === 'waiting_photo' && msg.photo) {
          console.log(`Photo received for ${stateKey}`);
          await deleteMessageSafe(chatId, state.serviceMessages[0]);

          const fileId = msg.photo.at(-1).file_id;
          const fileUrl = await getTelegramFileUrl(fileId);
          if (!fileUrl) {
            console.log(`Failed to get file URL for photo in ${stateKey}`);
            await sendMessage(chatId, '❌ Ошибка получения фото. Попробуйте еще раз.', { reply_to_message_id: state.messageId });
            return res.sendStatus(200);
          }

          state.photoUrl = fileUrl;
          state.photoDirectUrl = fileUrl;

          const sumMsg = await sendMessage(
            chatId,
            `💰 Укажите сумму работ (в сумах) для заявки #${row}`,
            { reply_to_message_id: state.messageId }
          );
          state.stage = 'waiting_sum';
          state.serviceMessages = [sumMsg.data.result.message_id];

          console.log(`State updated to waiting_sum for ${stateKey}, sumMsg ID: ${sumMsg.data.result.message_id}`);

          setTimeout(async () => {
            try {
              if (userStates[stateKey]?.stage === 'waiting_sum') {
                await deleteMessageSafe(chatId, sumMsg.data.result.message_id);
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания суммы истекло.', { reply_to_message_id: state.messageId });
                console.log(`Timeout triggered for ${stateKey} (waiting_sum), state cleared`);
              }
            } catch (e) {
              console.error(`Error handling sum timeout for ${stateKey}:`, e);
            }
          }, 60000); // 1 минута

          return res.sendStatus(200);
        }

        // Обработка суммы
        if (state?.stage === 'waiting_sum' && msg.text) {
          console.log(`Sum received for ${stateKey}: ${msg.text}`);
          await deleteMessageSafe(chatId, state.serviceMessages[0]);

          state.sum = msg.text;

          const commentMsg = await sendMessage(
            chatId,
            `💬 Напишите комментарий для заявки #${row}`,
            { reply_to_message_id: state.messageId }
          );
          state.stage = 'waiting_comment';
          state.serviceMessages = [commentMsg.data.result.message_id];

          console.log(`State updated to waiting_comment for ${stateKey}, commentMsg ID: ${commentMsg.data.result.message_id}`);

          setTimeout(async () => {
            try {
              if (userStates[stateKey]?.stage === 'waiting_comment') {
                await deleteMessageSafe(chatId, commentMsg.data.result.message_id);
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания комментария истекло.', { reply_to_message_id: state.messageId });
                console.log(`Timeout triggered for ${stateKey} (waiting_comment), state cleared`);
              }
            } catch (e) {
              console.error(`Error handling comment timeout for ${stateKey}:`, e);
            }
          }, 60000); // 1 минута

          return res.sendStatus(200);
        }

        // Обработка комментария
        if (state?.stage === 'waiting_comment' && msg.text) {
          console.log(`Comment received for ${stateKey}: ${msg.text}`);
          await deleteMessageSafe(chatId, state.serviceMessages[0]);

          state.comment = msg.text;

          const completionData = {
            row: state.row,
            sum: state.sum,
            comment: state.comment,
            photo: state.photoUrl,
            executor: state.username,
            originalRequest: state.originalRequest,
            delayDays: calculateDelayDays(state.originalRequest?.deadline),
            status: 'Выполнено',
            isEmergency: state.isEmergency,
            pizzeria: state.originalRequest?.pizzeria,
            problem: state.originalRequest?.problem,
            deadline: state.originalRequest?.deadline,
            initiator: state.originalRequest?.initiator,
            phone: state.originalRequest?.phone,
            category: state.originalRequest?.category,
            timestamp: new Date().toISOString()
          };

          // Отправка сообщения о закрытии как ответа на материнское сообщение
          await sendMessage(
            chatId, 
            formatCompletionMessage(completionData, state.photoUrl),
            { reply_to_message_id: state.messageId, disable_web_page_preview: false }
          );

          await sendToGAS(completionData);

          setTimeout(async () => {
            try {
              const diskUrl = await getGoogleDiskLink(state.row);
              if (diskUrl) {
                await sendMessage(
                  chatId, 
                  formatCompletionMessage(completionData, diskUrl),
                  { reply_to_message_id: state.messageId, disable_web_page_preview: false }
                );
                console.log(`Sent updated message with disk link for row ${state.row}`);
              }
            } catch (e) {
              console.error(`Error updating disk link for row ${state.row}:`, e);
            }
          }, 180000);

          await sendButtonsWithRetry(chatId, state.messageId, []);

          delete userStates[stateKey];
          console.log(`Completion process finished for ${stateKey}, state cleared`);

          return res.sendStatus(200);
        }

        // Обработка некорректных сообщений с кулдауном
        if ((msg.photo || msg.text) && !state && !text?.startsWith('/')) {
          const userId = msg.from.id;
          const lastErrorTime = errorMessageCooldown.get(userId) || 0;
          const now = Date.now();
          if (now - lastErrorTime > 60000) { // Кулдаун 1 минута
            errorMessageCooldown.set(userId, now);
            console.warn(`No state or row found for message in chat ${chatId}, text: ${text || 'photo'}`);
            await sendMessage(chatId, '❌ Пожалуйста, отправьте корректные данные для заявки.', {
              reply_to_message_id: messageId
            });
          }
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error.message, error.stack);
      return res.sendStatus(500);
    }
  });
};
