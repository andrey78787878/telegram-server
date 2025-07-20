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

// Хранилища
const userStorage = new Map();
const userStates = {};
const requestLinks = new Map();
const activeOperations = new Set();

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

async function notifyExecutor(executorUsername, row, chatId, messageId, requestData) {
  try {
    const executorId = userStorage.get(executorUsername);
    if (!executorId) {
      console.error(`Исполнитель ${executorUsername} не найден в хранилище`);
      return false;
    }

    requestLinks.set(`chat:${chatId}:${messageId}`, {
      executorId,
      executorUsername
    });

    const message = await sendMessage(
      executorId,
      `📌 Вам назначена заявка #${row}\n\n` +
      `🍕 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
      `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
      `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
      `⚠️ Приступайте к выполнению`,
      { 
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}:${chatId}:${messageId}` },
              { text: '⏳ Ожидает', callback_data: `wait:${row}:${chatId}:${messageId}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}:${chatId}:${messageId}` }
            ]
          ]
        },
        disable_notification: false 
      }
    );

    requestLinks.set(`ls:${executorId}:${message.result.message_id}`, {
      chatId,
      messageId
    });

    return true;
  } catch (e) {
    console.error('Ошибка отправки уведомления в ЛС:', e);
    return false;
  }
}

async function clearUserState(chatId) {
  const state = userStates[chatId];
  if (!state) return;

  await Promise.all(
    state.serviceMessages.map(id => 
      deleteMessageSafe(chatId, id).catch(console.error)
    )
  );
  
  delete userStates[chatId];
}

async function syncRequestStatus(chatId, messageId, completionData) {
  const operationKey = `sync-${chatId}-${messageId}`;
  
  if (activeOperations.has(operationKey)) {
    console.log(`Операция ${operationKey} уже выполняется`);
    return;
  }
  
  activeOperations.add(operationKey);
  
  try {
    // 1. Обновляем основное сообщение
    const messageText = formatCompletionMessage(completionData, completionData.photoUrl);
    const editResult = await editMessageSafe(chatId, messageId, messageText, {
      disable_web_page_preview: false
    });

    // 2. Обновляем ЛС исполнителя
    if (completionData.isFromLS) {
      const lsEntries = Array.from(requestLinks.entries())
        .filter(([key, val]) => key.startsWith('ls:') && 
               val.chatId === chatId && 
               val.messageId === messageId);
      
      for (const [lsKey, lsVal] of lsEntries) {
        const [, lsChatId, lsMessageId] = lsKey.split(':');
        await editMessageSafe(
          lsChatId, 
          lsMessageId,
          `✅ Заявка #${completionData.row} закрыта\n` +
          `📸 Фото отправлено\n` +
          `💰 Сумма: ${completionData.sum || '0'} сум\n` +
          `💬 Комментарий: ${completionData.comment || 'нет'}`,
          { disable_web_page_preview: false }
        ).catch(e => console.error('Ошибка обновления ЛС:', e));
      }
    }

    // 3. Отправляем в GAS
    await sendToGAS(completionData).catch(e => console.error("Ошибка GAS:", e));

    // 4. Обновляем ссылку на диск через 3 минуты
    setTimeout(async () => {
      try {
        const diskUrl = await getGoogleDiskLink(completionData.row);
        if (diskUrl) {
          await editMessageSafe(
            chatId, 
            messageId, 
            formatCompletionMessage(completionData, diskUrl),
            { disable_web_page_preview: false }
          );
        }
      } catch (e) {
        console.error('Error updating disk link:', e);
      } finally {
        activeOperations.delete(operationKey);
      }
    }, 180000);

    await sendButtonsWithRetry(chatId, messageId, []);
  } catch (e) {
    console.error('Error syncing request status:', e);
    activeOperations.delete(operationKey);
  }
}

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
        try {
          await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: callback_query.id
          });
        } catch (e) {
          console.error('Answer callback error:', e.message);
        }

        // Извлечение номера заявки
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(msg.text || msg.caption);
        if (!row || isNaN(row)) {
          console.error('Не удалось извлечь номер заявки');
          return res.sendStatus(200);
        }

        // Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          const accessDeniedMsg = await sendMessage(chatId, '❌ У вас нет доступа.');
          setTimeout(() => deleteMessageSafe(chatId, accessDeniedMsg.data.result.message_id), 3000);
          return res.sendStatus(200);
        }

        // Обработка кнопки "Принять в работу"
        if (data.startsWith('accept') || data === 'accept') {
          if (!MANAGERS.includes(username)) {
            const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут назначать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notManagerMsg.data.result.message_id), 3000);
            return res.sendStatus(200);
          }

          const isEmergency = msg.text?.includes('🚨') || msg.caption?.includes('🚨');
          
          // Для аварийных заявок
          if (isEmergency) {
            const requestData = parseRequestMessage(msg.text || msg.caption);
            
            const updatedText = `${msg.text || msg.caption}\n\n🚨 АВАРИЙНАЯ ЗАЯВКА - ТРЕБУЕТСЯ СРОЧНАЯ РЕАКЦИЯ!`;
            await editMessageSafe(chatId, messageId, updatedText);
            
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
                          { text: '✅ Выполнено', callback_data: `done:${row}:${chatId}:${messageId}` },
                          { text: '⏳ Ожидает', callback_data: `wait:${row}:${chatId}:${messageId}` },
                          { text: '❌ Отмена', callback_data: `cancel:${row}:${chatId}:${messageId}` }
                        ]
                      ]
                    },
                    disable_notification: false
                  }
                ).catch(e => console.error(`Error sending to ${recipient}:`, e));
              }
            }
            
            await sendToGAS({
              row,
              status: 'Аварийная',
              message_id: messageId,
              isEmergency: true
            });
            
            return res.sendStatus(200);
          }
  
          // Показываем кнопки выбора исполнителей
          const buttons = EXECUTORS.map(e => [
            { text: e, callback_data: `executor:${e}:${row}:${chatId}:${messageId}` }
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
          }, 20000);

          await sendButtonsWithRetry(chatId, messageId, buttons, `Выберите исполнителя для заявки #${row}:`);
          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя
        if (data.startsWith('executor:')) {
          const parts = data.split(':');
          const executorUsername = parts[1];
          const row = parts[2];
          const chatId = parts[3];
          const messageId = parts[4];
          
          // Удаляем сообщение с выбором исполнителя
          if (msg.reply_to_message) {
            await deleteMessageSafe(chatId, msg.reply_to_message.message_id).catch(console.error);
          }

          // Обновляем основное сообщение
          const newText = `${msg.text || msg.caption}\n\n🟢 Заявка в работе (исполнитель: ${executorUsername})`;
          await editMessageSafe(chatId, messageId, newText);

          // Устанавливаем кнопки действий
          const actionButtons = [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}:${chatId}:${messageId}` },
              { text: '⏳ Ожидает', callback_data: `wait:${row}:${chatId}:${messageId}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}:${chatId}:${messageId}` }
            ]
          ];

          await sendButtonsWithRetry(chatId, messageId, actionButtons, `Выберите действие для заявки #${row}:`);

          // Сохраняем связь между чатом и исполнителем
          const executorId = userStorage.get(executorUsername);
          if (executorId) {
            requestLinks.set(`chat:${chatId}:${messageId}`, { executorId, executorUsername });
          }

          // Отправляем уведомление в чат
          const notificationMsg = await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          // Удаляем уведомление через 20 секунд
          setTimeout(() => {
            deleteMessageSafe(chatId, notificationMsg.data.result.message_id).catch(console.error);
          }, 20000);

          // Отправляем уведомление в ЛС
          try {
            if (executorId) {
              const requestData = parseRequestMessage(msg.text || msg.caption);
              
              const lsMessage = await sendMessage(
                executorId,
                `📌 Вам назначена заявка #${row}\n\n` +
                `🍕 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                `⚠️ Приступайте к выполнению`,
                { 
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: '✅ Выполнено', callback_data: `done:${row}:${chatId}:${messageId}` },
                        { text: '⏳ Ожидает', callback_data: `wait:${row}:${chatId}:${messageId}` },
                        { text: '❌ Отмена', callback_data: `cancel:${row}:${chatId}:${messageId}` }
                      ]
                    ]
                  },
                  disable_notification: false 
                }
              );

              // Сохраняем связь ЛС с чатом
              requestLinks.set(`ls:${executorId}:${lsMessage.data.result.message_id}`, { chatId, messageId });
            }
          } catch (e) {
            console.error('Ошибка отправки уведомления в ЛС:', e);
          }

          await sendToGAS({
            row,
            status: 'В работе',
            executor: executorUsername,
            message_id: messageId
          });

          return res.sendStatus(200);
        }

        // Обработка завершения заявки
        if (data.startsWith('done:')) {
          const parts = data.split(':');
          const row = parseInt(parts[1]);
          const sourceChatId = parts[2] || msg.chat.id;
          const sourceMessageId = parts[3] || msg.message_id;

          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(msg.chat.id, '❌ Только исполнители могут завершать заявки.');
            setTimeout(() => deleteMessageSafe(msg.chat.id, notExecutorMsg.data.result.message_id), 3000);
            return res.sendStatus(200);
          }

          // Определяем, откуда пришло действие (чат или ЛС)
          const isFromLS = msg.chat.id !== sourceChatId;
          let targetChatId = sourceChatId;
          let targetMessageId = sourceMessageId;

          // Если действие из ЛС, находим соответствующее сообщение в чате
          if (isFromLS) {
            const link = requestLinks.get(`ls:${msg.chat.id}:${msg.message_id}`);
            if (link) {
              targetChatId = link.chatId;
              targetMessageId = link.messageId;
            }
          }

          // Проверяем, не начали ли уже процесс завершения
          if (userStates[msg.chat.id]?.stage) {
            return res.sendStatus(200);
          }

          // Создаем уникальный идентификатор операции
          const operationId = `done_${targetChatId}_${targetMessageId}_${Date.now()}`;
          
          // Запрашиваем фото
          const photoMsg = await sendMessage(
            msg.chat.id, 
            '📸 Пришлите фото выполненных работ\n\n' +
            '⚠️ Для отмены нажмите /cancel'
          );
          
          // Сохраняем состояние
          userStates[msg.chat.id] = {
            operationId,
            stage: 'waiting_photo',
            row,
            username,
            messageId: targetMessageId,
            chatId: targetChatId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [photoMsg.data.result.message_id],
            isEmergency: msg.text?.includes('🚨') || msg.caption?.includes('🚨'),
            isFromLS
          };

          // Устанавливаем таймер очистки
          setTimeout(() => {
            if (userStates[msg.chat.id]?.operationId === operationId) {
              delete userStates[msg.chat.id];
              deleteMessageSafe(msg.chat.id, photoMsg.data.result.message_id).catch(console.error);
            }
          }, 120000);

          return res.sendStatus(200);
        }

        // Обработка ожидания поставки
        if (data.startsWith('wait:')) {
          if (!EXECUTORS.includes(username)) {
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут менять статус заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 3000);
            return res.sendStatus(200);
          }

          const notificationMsg = await sendMessage(chatId, '⏳ Заявка переведена в статус "Ожидает поставки"', { 
            reply_to_message_id: messageId 
          });
          
          setTimeout(() => {
            deleteMessageSafe(chatId, notificationMsg.data.result.message_id).catch(console.error);
          }, 20000);
          
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
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 3000);
            return res.sendStatus(200);
          }

          const notificationMsg = await sendMessage(chatId, '🚫 Заявка отменена', { 
            reply_to_message_id: messageId 
          });
          
          setTimeout(() => {
            deleteMessageSafe(chatId, notificationMsg.data.result.message_id).catch(console.error);
          }, 20000);
          
          await sendToGAS({ 
            row: parseInt(data.split(':')[1]), 
            status: 'Отменено' 
          });
          
          return res.sendStatus(200);
        }
      }

   // Обработка обычных сообщений (фото, сумма, комментарий)
if (body.message && userStates[body.message.chat.id]) {
  const msg = body.message;
  const chatId = msg.chat.id;
  const state = userStates[chatId];

  // Обработка команды отмены
  if (msg.text === '/cancel') {
    await clearUserState(chatId);
    await sendMessage(chatId, '❌ Процесс завершения заявки отменен');
    return res.sendStatus(200);
  }

  // Обработка фото
// Обработка фото
if (state.stage === 'waiting_photo' && msg.photo) {
  await deleteMessageSafe(chatId, state.serviceMessages[0]).catch(console.error);

  const photoId = msg.photo[msg.photo.length - 1].file_id;
  const file = await getFileLink(photoId);
  const fileUrl = `${TELEGRAM_FILE_API}/${file.file_path}`;

  const photoBuffer = await axios.get(fileUrl, { responseType: 'arraybuffer' }).then(res => res.data);
  const fileName = `photo_${Date.now()}.jpg`;

  const driveResponse = await uploadToDrive(photoBuffer, fileName, state.row);
  const photoLink = driveResponse.webViewLink;

  state.photoLink = photoLink;
  state.stage = 'waiting_sum';

  const sumPrompt = await sendMessage(chatId, '💰 Укажи сумму выполненных работ (в сумах):');
  userStates[chatId].serviceMessages.push(sumPrompt.message_id);
  return;
}

// Обработка суммы
if (state.stage === 'waiting_sum' && msg.text) {
  await deleteMessageSafe(chatId, state.serviceMessages[1]).catch(console.error);

  const sum = msg.text.replace(/\D/g, '');
  state.sum = sum || '0';
  state.stage = 'waiting_comment';

  const commentPrompt = await sendMessage(chatId, '💬 Напиши краткий комментарий (что было сделано):');
  userStates[chatId].serviceMessages.push(commentPrompt.message_id);
  return;
}

// Обработка комментария
if (state.stage === 'waiting_comment' && msg.text) {
  await deleteMessageSafe(chatId, state.serviceMessages[2]).catch(console.error);

  const comment = msg.text;
  state.comment = comment;

  // Обновляем Google Таблицу
  await axios.post(GAS_WEB_APP_URL, {
    photo: state.photoLink,
    sum: state.sum,
    comment: state.comment,
    row: state.row,
    username: msg.from.username,
    executor: msg.from.username,
    message_id: state.messageId
  });

  // Синхронизируем статус в материнском сообщении
  await syncRequestStatus(state.chatId, state.messageId, {
    photo: state.photoLink,
    sum: state.sum,
    comment: state.comment,
    row: state.row,
    username: msg.from.username,
    executor: msg.from.username,
  });

  // Если действие было из ЛС — обновим и там
  if (state.isFromLS) {
    await editMessageSafe(
      chatId,
      msg.message_id,
      `✅ Заявка #${state.row} закрыта\n` +
      `📸 Фото отправлено\n` +
      `💰 Сумма: ${state.sum || '0'} сум\n` +
      `💬 Комментарий: ${state.comment || 'нет'}`,
      { disable_web_page_preview: false }
    );
  }

  // Финальное сообщение
  const finalMessage = await sendMessage(chatId, `🎉 Заявка #${state.row} закрыта. Спасибо!`);
  userStates[chatId].serviceMessages.push(finalMessage.message_id);

  // Удаляем все промежуточные сообщения через минуту
  setTimeout(() => {
    const toDelete = [msg.message_id, ...state.serviceMessages];
    toDelete.forEach(messageId => deleteMessageSafe(chatId, messageId).catch(console.error));
  }, 60000);

  // Очищаем состояние
  delete userStates[chatId];
}

    // Отправляем данные в Google Apps Script
    await sendToGAS(completionData).catch(console.error);

    // Удаляем кнопки управления
    await sendButtonsWithRetry(state.chatId, state.messageId, []).catch(console.error);

    // Очищаем состояние
    delete userStates[chatId];
    
    return res.sendStatus(200);

    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(500);
    }
  }); // закрывает app.post('/webhook'
}); // закрывает module.exports
