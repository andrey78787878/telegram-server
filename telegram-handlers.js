const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// Время жизни сервисных сообщений (1 минута)
const MESSAGE_LIFETIME = 60000;

// Права пользователей
const MANAGERS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const EXECUTORS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Хранилище user_id (username -> id)
const userStorage = new Map();

// Вспомогательные функции
function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  return parts.length > 2 ? parseInt(parts[2], 10) : null;
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

        // Извлечение номера заявки
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(msg.text || msg.caption);
        if (!row) {
          console.error('Не удалось извлечь номер заявки');
          return res.sendStatus(200);
        }

        // Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          const accessDeniedMsg = await sendMessage(chatId, '❌ У вас нет доступа.');
          setTimeout(() => deleteMessageSafe(chatId, accessDeniedMsg.data.result.message_id), 30000);
          return res.sendStatus(200);
        }

        // Обработка кнопки "Принять в работу"
        if (data === 'accept') {
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
                          { text: '⏳ Ожидает', callback_data: `wait:${row}` }
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
          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя
        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
          
          // Удаляем сообщение "Выберите исполнителя"
          if (msg.reply_to_message) {
            await deleteMessageSafe(chatId, msg.reply_to_message.message_id);
          }

          // Обновляем основное сообщение (убираем кнопки)
          const requestData = parseRequestMessage(msg.text || msg.caption);
          const isEmergency = msg.text?.includes('🚨') || msg.caption?.includes('🚨');
          
          const updatedMessage = `
📌 Заявка #${row} ${isEmergency ? '🚨 АВАРИЙНАЯ' : ''}
🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}
🔧 Проблема: ${requestData?.problem || 'не указано'}
🕓 Срок: ${requestData?.deadline || 'не указан'}
━━━━━━━━━━━━
🟢 В работе (исполнитель: ${executorUsername})
          `.trim();

          await editMessageSafe(chatId, messageId, updatedMessage, {
            reply_markup: { inline_keyboard: [] } // Убираем все кнопки
          });

          // Отправляем уведомление в чат
          await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          // Отправляем кнопки действий в ЛС исполнителю
          try {
            const executorId = userStorage.get(executorUsername);
            if (executorId) {
              await sendMessage(
                executorId,
                `📌 Вам назначена заявка #${row}\n\n` +
                `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                `Пожалуйста, подтвердите принятие заявки:`,
                { 
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: '✅ Принять', callback_data: `confirm:${row}` },
                        { text: '❌ Отклонить', callback_data: `reject:${row}` }
                      ]
                    ]
                  },
                  disable_notification: false
                }
              );
            }
          } catch (e) {
            console.error('Ошибка отправки уведомления:', e);
            await sendMessage(
              chatId,
              `❌ Не удалось уведомить ${executorUsername} в ЛС`,
              { reply_to_message_id: messageId }
            );
          }

          // Отправляем данные в GAS
          await sendToGAS({
            row,
            status: 'Ожидает подтверждения',
            executor: executorUsername,
            message_id: messageId,
            isEmergency: isEmergency
          });

          return res.sendStatus(200);
        }

        // Обработка подтверждения исполнителя
        if (data.startsWith('confirm:')) {
          const row = parseInt(data.split(':')[1]);
          
          // Получаем данные из хранилища состояний
          const requestData = parseRequestMessage(msg.text || msg.caption);
          const isEmergency = msg.text?.includes('🚨') || msg.caption?.includes('🚨');
          
          // Обновляем сообщение в чате
          const updatedText = `
📌 Заявка #${row} ${isEmergency ? '🚨 АВАРИЙНАЯ' : ''}
🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}
🔧 Проблема: ${requestData?.problem || 'не указано'}
🕓 Срок: ${requestData?.deadline || 'не указан'}
━━━━━━━━━━━━
🟢 В работе (исполнитель: @${user.username})
          `.trim();

          await editMessageSafe(chatId, messageId, updatedText);

          // Отправляем кнопки управления в ЛС исполнителю
          await sendMessage(
            msg.chat.id,
            'Вы приняли заявку. Выберите действие:',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Выполнено', callback_data: `done:${row}` },
                    { text: '⏳ Ожидает', callback_data: `wait:${row}` }
                  ]
                ]
              }
            }
          );

          // Обновляем статус в GAS
          await sendToGAS({
            row,
            status: 'В работе',
            executor: `@${user.username}`
          });

          return res.sendStatus(200);
        }

        // Обработка отклонения заявки
        if (data.startsWith('reject:')) {
          const row = parseInt(data.split(':')[1]);
          
          // Возвращаем заявку в чат
          const mainChatId = msg.chat.id; // ID основного чата
          const originalText = msg.text.replace('Вам назначена заявка', 'Заявка требует назначения');
          
          await sendMessage(
            mainChatId,
            originalText,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: 'Принять в работу', callback_data: `accept:${row}` }]
                ]
              }
            }
          );

          // Обновляем статус
          await sendToGAS({
            row,
            status: 'Требует назначения',
            executor: null
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

          // Отправляем запрос на фото (1 минута на ответ)
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
            serviceMessages: [{
              id: photoMsg.data.result.message_id,
              deleteAt: Date.now() + MESSAGE_LIFETIME
            }],
            isEmergency: msg.text?.includes('🚨') || msg.caption?.includes('🚨')
          };

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

        // Удаляем просроченные сервисные сообщения
        state.serviceMessages = state.serviceMessages.filter(m => {
          if (Date.now() >= m.deleteAt) {
            deleteMessageSafe(chatId, m.id).catch(console.error);
            return false;
          }
          return true;
        });

        // Получение фото
        if (state.stage === 'waiting_photo' && msg.photo) {
          await deleteMessageSafe(chatId, state.serviceMessages[0].id);
          
          const fileId = msg.photo.at(-1).file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          
          const sumMsg = await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
          state.stage = 'waiting_sum';
          state.serviceMessages = [{
            id: sumMsg.data.result.message_id,
            deleteAt: Date.now() + MESSAGE_LIFETIME
          }];
          
          return res.sendStatus(200);
        }

        // Получение суммы
        if (state.stage === 'waiting_sum' && msg.text) {
          await deleteMessageSafe(chatId, state.serviceMessages[0].id);
          
          state.sum = msg.text;
          
          const commentMsg = await sendMessage(chatId, '💬 Напишите комментарий');
          state.stage = 'waiting_comment';
          state.serviceMessages = [{
            id: commentMsg.data.result.message_id,
            deleteAt: Date.now() + MESSAGE_LIFETIME
          }];
          
          return res.sendStatus(200);
        }

        // Получение комментария
        if (state.stage === 'waiting_comment' && msg.text) {
          await deleteMessageSafe(chatId, state.serviceMessages[0].id);
          
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

          // Первоначальное обновление сообщения
          await editMessageSafe(
            chatId, 
            state.messageId, 
            formatCompletionMessage(completionData, state.photoUrl),
            { disable_web_page_preview: false }
          );

          // Отправка данных в GAS
          await sendToGAS(completionData);

          // Обновление через 3 минуты с ссылкой из Google Drive
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
              }
            } catch (e) {
              console.error('Error updating disk link:', e);
            }
          }, 180000); // 3 минуты

          // Удаляем все кнопки
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
