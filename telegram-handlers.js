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

// Хранилище user_id (username -> id)
const userStorage = new Map();

// Вспомогательные функции
function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  // Поддерживаем форматы: action:row и action:param:row
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

// Хранилище состояний
const userStates = {};

module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      
      // Сохраняем user_id при любом сообщении
      if (body.message?.from) {
        const user = body.message.from;
        if (user.username) {
          userStorage.set(`@${user.username}`, user.id);
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

        // Ответ на callback_query
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callback_query.id
        }).catch(e => console.error('Answer callback error:', e));

        // Извлечение номера заявки (исправленная версия)
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(msg.text || msg.caption);
        if (!row || isNaN(row)) {
          console.error('Не удалось извлечь номер заявки:', {
            callbackData: data,
            messageText: msg.text,
            messageCaption: msg.caption
          });
          await sendMessage(chatId, '❌ Ошибка: не найден номер заявки');
          return res.sendStatus(200);
        }

        // Проверка прав
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
          
          // Для аварийных заявок - сразу уведомляем всех менеджеров и исполнителей
          if (isEmergency) {
            const requestData = parseRequestMessage(msg.text || msg.caption);
            
            // Обновляем сообщение в чате
            const updatedText = `${msg.text || msg.caption}\n\n🚨 АВАРИЙНАЯ ЗАЯВКА - ТРЕБУЕТСЯ СРОЧНАЯ РЕАКЦИЯ!`;
            await editMessageSafe(chatId, messageId, updatedText);
            
            // Уведомляем всех менеджеров и исполнителей
            const allRecipients = [...new Set([...MANAGERS, ...EXECUTORS])];
            
            for (const recipient of allRecipients) {
              const recipientId = userStorage.get(recipient);
              if (recipientId) {
                await sendMessage(
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
              }
            }
            
            // Отправляем данные в GAS
            await sendToGAS({
              row,
              status: 'Аварийная',
              message_id: messageId,
              isEmergency: true
            });
            
            return res.sendStatus(200);
          }
          
          // Для обычных заявок - стандартная логика с выбором исполнителя
          const updatedText = `${msg.text || msg.caption}\n\n🟢 Заявка в работе`;
          await editMessageSafe(chatId, messageId, updatedText);

          // Добавляем кнопки для закрытия заявки в чате
          const buttons = [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '⏳ Ожидает', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` }
            ]
          ];

          await sendButtonsWithRetry(chatId, messageId, buttons, `Выберите действие для заявки #${row}:`);
          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя (старая логика удалена, так как теперь сразу кнопки действий)

        // Обработка завершения заявки
        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут завершать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          // Отправляем запрос на фото
          const photoMsg = await sendMessage(
            chatId, 
            '📸 Пришлите фото выполненных работ\n\n' +
            '⚠️ Для отмены нажмите /cancel',
            { reply_to_message_id: messageId }
          );
          
          userStates[chatId] = {
            stage: 'waiting_photo',
            row: parseInt(data.split(':')[1]),
            username,
            messageId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [photoMsg.data.result.message_id],
            isEmergency: msg.text?.includes('🚨') || msg.caption?.includes('🚨')
          };

          setTimeout(() => {
            deleteMessageSafe(chatId, photoMsg.data.result.message_id).catch(e => console.error(e));
          }, 120000);

          return res.sendStatus(200);
        }

        // Обработка ожидания поставки
        if (data.startsWith('wait:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут менять статус заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          await sendMessage(chatId, '⏳ Заявка переведена в статус "Ожидает поставки"', { 
            reply_to_message_id: messageId 
          });
          
          await sendToGAS({ 
            row: parseInt(data.split(':')[1]), 
            status: 'Ожидает поставки' 
          });
          
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
          
          await sendToGAS({ 
            row: parseInt(data.split(':')[1]), 
            status: 'Отменено' 
          });
          
          return res.sendStatus(200);
        }
      }

      // Обработка обычных сообщений
      if (body.message && userStates[body.message.chat.id]) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const state = userStates[chatId];

        // Получение фото
        if (state.stage === 'waiting_photo' && msg.photo) {
          await deleteMessageSafe(chatId, state.serviceMessages[0]);
          
          const fileId = msg.photo.at(-1).file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          
          const sumMsg = await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
          state.stage = 'waiting_sum';
          state.serviceMessages = [sumMsg.data.result.message_id];
          
          setTimeout(() => {
            deleteMessageSafe(chatId, sumMsg.data.result.message_id).catch(e => console.error(e));
          }, 120000);
          
          return res.sendStatus(200);
        }

        // Получение суммы
        if (state.stage === 'waiting_sum' && msg.text) {
          await deleteMessageSafe(chatId, state.serviceMessages[0]);
          
          state.sum = msg.text;
          
          const commentMsg = await sendMessage(chatId, '💬 Напишите комментарий');
          state.stage = 'waiting_comment';
          state.serviceMessages = [commentMsg.data.result.message_id];
          
          setTimeout(() => {
            deleteMessageSafe(chatId, commentMsg.data.result.message_id).catch(e => console.error(e));
          }, 120000);
          
          return res.sendStatus(200);
        }

        // Получение комментария
        if (state.stage === 'waiting_comment' && msg.text) {
          await deleteMessageSafe(chatId, state.serviceMessages[0]);
          
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

          // Обновляем сообщение в чате
          await editMessageSafe(
            chatId, 
            state.messageId, 
            formatCompletionMessage(completionData, state.photoUrl),
            { disable_web_page_preview: false }
          );

          // Отправляем данные в GAS
          await sendToGAS(completionData);

          // Если это дочерняя заявка, закрываем и материнскую
          if (state.isChildRequest) {
            try {
              const parentMessageId = state.parentMessageId;
              if (parentMessageId) {
                await editMessageSafe(
                  chatId,
                  parentMessageId,
                  formatCompletionMessage(completionData, state.photoUrl),
                  { disable_web_page_preview: false }
                );
              }
            } catch (e) {
              console.error('Error closing parent request:', e);
            }
          }

          setTimeout(async () => {
            try {
              const diskUrl = await getGoogleDiskLink(state.row);
              if (diskUrl) {
                await editMessageSafe(
                  chatId, 
                  state.messageId, 
                  formatCompletionMessage(completionData, diskUrl),
                  { disable_web_page_preview: false }
                );
                
                // Обновляем материнскую заявку, если есть
                if (state.isChildRequest && state.parentMessageId) {
                  await editMessageSafe(
                    chatId,
                    state.parentMessageId,
                    formatCompletionMessage(completionData, diskUrl),
                    { disable_web_page_preview: false }
                  );
                }
              }
            } catch (e) {
              console.error('Error updating disk link:', e);
            }
          }, 180000);

          await sendButtonsWithRetry(chatId, state.messageId, []);

          delete userStates[chatId];
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
