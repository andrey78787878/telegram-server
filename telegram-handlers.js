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

// Хранилище user_id (username -> id)
const userStorage = new Map();

// Хранилище связанных сообщений (row -> {chatId, chatMessageId, privateMessageIds})
const messageLinks = new Map();

// Хранилище состояний на основе user.id
const userStates = new Map();

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
  try {
    return await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
  } catch (error) {
    console.error('Send message error:', error.response?.data);
    throw error;
  }
}

async function editMessageSafe(chatId, messageId, text, options = {}) {
  try {
    return await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options
    });
  } catch (error) {
    if (error.response?.data?.description?.includes('no text in the message') || 
        error.response?.data?.description?.includes('message to edit not found')) {
      return await sendMessage(chatId, text, options);
    }
    console.error('Edit message error:', error.response?.data);
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
    return response;
  } catch (error) {
    if (error.response?.data?.description?.includes('not modified')) {
      return { ok: true };
    }
    return await sendMessage(chatId, fallbackText, {
      reply_markup: { inline_keyboard: buttons }
    });
  }
}

async function deleteMessageSafe(chatId, messageId) {
  try {
    return await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.error('Delete message error:', error.response?.data);
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

async function sendToGAS(data) {
  try {
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
    return res.data.diskLink || null;
  } catch (error) {
    console.error('Get Google Disk link error:', error.response?.data);
    return null;
  }
}

async function syncRequestStatus(row, completionData) {
  try {
    const links = messageLinks.get(row);
    if (!links) return;

    const completionMessage = formatCompletionMessage(completionData);
    
    if (links.chatMessageId) {
      await editMessageSafe(links.chatId, links.chatMessageId, completionMessage, {
        disable_web_page_preview: false
      });
      await sendButtonsWithRetry(links.chatId, links.chatMessageId, []);
    }
    
    if (links.privateMessageIds) {
      for (const {chatId, messageId} of links.privateMessageIds) {
        await editMessageSafe(chatId, messageId, completionMessage, {
          disable_web_page_preview: false
        });
        await sendButtonsWithRetry(chatId, messageId, []);
      }
    }
  } catch (error) {
    console.error('Error syncing request status:', error);
  }
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
          await sendMessage(chatId, '❌ Ошибка: не найден номер заявки');
          return res.sendStatus(200);
        }

        if (!AUTHORIZED_USERS.includes(username)) {
          const accessDeniedMsg = await sendMessage(chatId, '❌ У вас нет доступа.');
          setTimeout(() => deleteMessageSafe(chatId, accessDeniedMsg.data.result.message_id), 30000);
          return res.sendStatus(200);
        }

        if (data.startsWith('accept') || data === 'accept') {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут назначать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          const isEmergency = msg.text?.includes('🚨') || msg.caption?.includes('🚨');
          
          if (isEmergency) {
            const requestData = parseRequestMessage(msg.text || msg.caption);
            await editMessageSafe(chatId, messageId, `${msg.text || msg.caption}\n\n🚨 АВАРИЙНАЯ ЗАЯВКА - ТРЕБУЕТСЯ СРОЧНАЯ РЕАКЦИЯ!`);
            
            if (!messageLinks.has(row)) {
              messageLinks.set(row, {
                chatId: chatId,
                chatMessageId: messageId,
                privateMessageIds: []
              });
            }
            
            for (const recipient of [...new Set([...MANAGERS, ...EXECUTORS])]) {
              const recipientId = userStorage.get(recipient);
              if (recipientId) {
                const privateMsg = await sendMessage(
                  recipientId,
                  `🚨 АВАРИЙНАЯ ЗАЯВКА #${row}\n\n` +
                  `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                  `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                  `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                  `‼️ ТРЕБУЕТСЯ НЕМЕДЛЕННАЯ РЕАКЦИЯ!`,
                  {
                    reply_markup: {
                      inline_keyboard: [
                        [
                          { text: '✅ Выполнено', callback_data: `done:${row}` },
                          { text: '⏳ Ожидает', callback_data: `wait:${row}` },
                          { text: '❌ Отмена', callback_data: `cancel:${row}` }
                        ]
                      ]
                    },
                    disable_notification: false
                  }
                ).catch(e => console.error(`Error sending to ${recipient}:`, e));
                
                if (privateMsg?.data?.result) {
                  const links = messageLinks.get(row);
                  links.privateMessageIds.push({
                    chatId: recipientId,
                    messageId: privateMsg.data.result.message_id
                  });
                }
              }
            }
            
            await sendToGAS({ row, status: 'Аварийная', message_id: messageId, isEmergency: true });
            return res.sendStatus(200);
          }
          
          const buttons = EXECUTORS.map(e => [
            { text: e, callback_data: `executor:${e}:${row}` }
          ]);

          const chooseExecutorMsg = await sendMessage(chatId, `👷 Выберите исполнителя для заявки #${row}:`, {
            reply_to_message_id: messageId
          });

          setTimeout(() => deleteMessageSafe(chatId, chooseExecutorMsg.data.result.message_id).catch(console.error), 60000);

          await sendButtonsWithRetry(chatId, messageId, buttons, `Выберите исполнителя для заявки #${row}:`);
          return res.sendStatus(200);
        }

        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
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
          await sendMessage(chatId, `📢 ${executorUsername}, вам назначена заявка #${row}!`, { reply_to_message_id: messageId });

          try {
            const executorId = userStorage.get(executorUsername);
            if (executorId) {
              const requestData = parseRequestMessage(msg.text || msg.caption);
              
              if (!messageLinks.has(row)) {
                messageLinks.set(row, {
                  chatId: chatId,
                  chatMessageId: messageId,
                  privateMessageIds: []
                });
              }
              
              const privateMsg = await sendMessage(
                executorId,
                `📌 Вам назначена заявка #${row}\n\n` +
                `🍕 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                `⚠️ Приступайте к выполнению`,
                { 
                  reply_markup: { inline_keyboard: actionButtons },
                  disable_notification: false 
                }
              );
              
              if (privateMsg?.data?.result) {
                const links = messageLinks.get(row);
                links.privateMessageIds.push({
                  chatId: executorId,
                  messageId: privateMsg.data.result.message_id
                });
              }
            }
          } catch (e) {
            console.error('Ошибка отправки уведомления в ЛС:', e);
          }

          await sendToGAS({ row, status: 'В работе', executor: executorUsername, message_id: messageId });
          return res.sendStatus(200);
        }

        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут завершать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 90000);
            return res.sendStatus(200);
          }

          const stateId = `${user.id}:${row}`;
          userStates.set(stateId, {
            stage: 'waiting_photo',
            row: parseInt(data.split(':')[1]),
            username,
            chatId,
            messageId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [],
            isEmergency: msg.text?.includes('🚨') || msg.caption?.includes('🚨'),
            isPrivate: chatId === user.id
          });

          const photoMsg = await sendMessage(
            chatId, 
            '📸 Пришлите фото выполненных работ\n\n⚠️ Для отмены нажмите /cancel',
            msg.chat.type !== 'private' ? { reply_to_message_id: messageId } : {}
          );
          
          userStates.get(stateId).serviceMessages.push(photoMsg.data.result.message_id);

          setTimeout(() => deleteMessageSafe(chatId, photoMsg.data.result.message_id).catch(console.error), 120000);
          return res.sendStatus(200);
        }

        if (data.startsWith('wait:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут менять статус заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 90000);
            return res.sendStatus(200);
          }

          const row = parseInt(data.split(':')[1]);
          const requestData = parseRequestMessage(msg.text || msg.caption);
          
          await syncRequestStatus(row, {
            row,
            status: 'Ожидает поставки',
            executor: username,
            originalRequest: requestData,
            isEmergency: msg.text?.includes('🚨') || msg.caption?.includes('🚨')
          });
          
          await sendToGAS({ row, status: 'Ожидает поставки' });
          return res.sendStatus(200);
        }

        if (data.startsWith('cancel:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут отменять заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          const row = parseInt(data.split(':')[1]);
          const requestData = parseRequestMessage(msg.text || msg.caption);
          
          await syncRequestStatus(row, {
            row,
            status: 'Отменено',
            executor: username,
            originalRequest: requestData,
            isEmergency: msg.text?.includes('🚨') || msg.caption?.includes('🚨')
          });
          
          await sendToGAS({ row, status: 'Отменено' });
          return res.sendStatus(200);
        }
      }

      if (body.message) {
        const msg = body.message;
        const user = msg.from;
        const chatId = msg.chat.id;
        const stateId = `${user.id}:${extractRowFromMessage(msg.text)}`;
        const state = userStates.get(stateId);

        if (state) {
          if (state.stage === 'waiting_photo' && msg.photo) {
            await Promise.all(state.serviceMessages.map(id => deleteMessageSafe(chatId, id)));
            const fileId = msg.photo.at(-1).file_id;
            state.photoUrl = await getTelegramFileUrl(fileId);
            const sumMsg = await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
            state.stage = 'waiting_sum';
            state.serviceMessages = [sumMsg.data.result.message_id];
            setTimeout(() => deleteMessageSafe(chatId, sumMsg.data.result.message_id).catch(console.error), 120000);
            return res.sendStatus(200);
          }

          if (state.stage === 'waiting_sum' && msg.text) {
            await Promise.all(state.serviceMessages.map(id => deleteMessageSafe(chatId, id)));
            state.sum = msg.text;
            const commentMsg = await sendMessage(chatId, '💬 Напишите комментарий');
            state.stage = 'waiting_comment';
            state.serviceMessages = [commentMsg.data.result.message_id];
            setTimeout(() => deleteMessageSafe(chatId, commentMsg.data.result.message_id).catch(console.error), 120000);
            return res.sendStatus(200);
          }

          if (state.stage === 'waiting_comment' && msg.text) {
            await Promise.all(state.serviceMessages.map(id => deleteMessageSafe(chatId, id)));
            state.comment = msg.text;

            const completionData = {
              row: state.row,
              sum: state.sum,
              comment: state.comment,
              photoUrl: state.photoUrl,
              executor: state.username,
              originalRequest: state.originalRequest,
              delayDays: calculateDelayDays(state.originalRequest?.deadline),
              status: 'Выполнено',
              isEmergency: state.isEmergency
            };

            await syncRequestStatus(state.row, completionData);
            await sendToGAS(completionData);

            setTimeout(async () => {
              try {
                const diskUrl = await getGoogleDiskLink(state.row);
                if (diskUrl) {
                  completionData.photoUrl = diskUrl;
                  await syncRequestStatus(state.row, completionData);
                }
              } catch (e) {
                console.error('Error updating disk link:', e);
              }
            }, 180000);

            userStates.delete(stateId);
            return res.sendStatus(200);
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
