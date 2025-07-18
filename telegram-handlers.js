const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// Права пользователей
const MANAGERS = ['@EvelinaB87', '@Andrey_Tkach_MB', '@Davr_85'];
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

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

async function editMessageSafe(chatId, messageId, text) {
  try {
    return await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML'
    });
  } catch (error) {
    if (error.response?.data?.description?.includes('no text in the message') || 
        error.response?.data?.description?.includes('message to edit not found')) {
      return await sendMessage(chatId, text);
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

function formatCompletionMessage(data, diskUrl = null) {
  return `
📌 Заявка #${data.row} закрыта.
${diskUrl ? `📎 Фото: ${diskUrl}\n` : data.photoUrl ? `📎 Фото: ${data.photoUrl}\n` : ''}
💰 Сумма: ${data.sum || '0'} сум
👤 Исполнитель: ${data.executor}
✅ Статус: Выполнено
${data.delayDays > 0 ? `🔴 Просрочка: ${data.delayDays} дн.\n` : ''}
💬 Комментарий: ${data.comment || 'нет комментария'}

━━━━━━━━━━━━

📍 Заявка #${data.row}
🏢 Пиццерия: ${data.originalRequest?.pizzeria || 'не указано'}
📂 Категория: ${data.originalRequest?.category || 'не указано'}
🛠 Проблема: ${data.originalRequest?.problem || 'не указано'}
🙋 Инициатор: ${data.originalRequest?.initiator || 'не указано'}
${data.originalRequest?.phone ? `📞 Телефон: ${data.originalRequest.phone}\n` : ''}
${data.originalRequest?.deadline ? `🕓 Срок: ${data.originalRequest.deadline}` : ''}
  `.trim();
}

// Хранилище user_id
const userStorage = new Map();

module.exports = (app, userStates) => {
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

        if (!callback_query || !callback_query.message || !callback_query.data || !user) {
          return res.sendStatus(200);
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
          console.error('Answer callback error:', e.response?.data);
        }

        // Извлечение номера заявки
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(msg.text || msg.caption);
        
        if (!row) {
          console.error('Не удалось извлечь номер заявки');
          return res.sendStatus(200);
        }

        console.log('Callback received:', { username, data, row });

        // Проверка прав доступа
        if (!AUTHORIZED_USERS.includes(username)) {
          await sendMessage(chatId, '❌ У вас нет доступа.');
          return res.sendStatus(200);
        }

        // Обработка "Принять в работу"
        if (data === 'accept') {
          if (!MANAGERS.includes(username)) {
            await sendMessage(chatId, '❌ Только менеджеры могут назначать заявки.');
            return res.sendStatus(200);
          }

          const updatedText = `${msg.text || msg.caption}\n\n🟢 Заявка в работе`;
          await editMessageSafe(chatId, messageId, updatedText);

          const buttons = EXECUTORS.map(e => [
            { text: e, callback_data: `executor:${e}:${row}` }
          ]);

          await sendMessage(chatId, `👷 Выберите исполнителя для заявки #${row}:`, {
            reply_to_message_id: messageId
          });

          await sendButtonsWithRetry(chatId, messageId, buttons, `Выберите исполнителя для заявки #${row}:`);
          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя
        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
          
          // Формируем новый текст для основного сообщения
          const newText = `📍 Заявка #${row} закреплена за ${executorUsername}\n`
                        + `🟢 Статус: В работе\n\n`
                        + `📌 Детали заявки:\n`
                        + (msg.text || msg.caption).split('\n').slice(1).join('\n');

          // Редактируем исходное сообщение
          await editMessageSafe(chatId, messageId, newText);

          // Обновляем кнопки
          const buttons = [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '🕐 Ожидает поставки', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` }
            ]
          ];
          await sendButtonsWithRetry(chatId, messageId, buttons);

          // Отправляем временное уведомление (reply к основному сообщению)
          const notification = await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          // Удаляем уведомление через 1 минуту
          setTimeout(async () => {
            try {
              await deleteMessageSafe(chatId, notification.data.result.message_id);
            } catch (e) {
              console.error('Не удалось удалить уведомление:', e);
            }
          }, 60_000);

          // Отправляем данные в GAS
          await sendToGAS({
            row,
            status: 'В работе',
            executor: executorUsername,
            message_id: messageId,
          });

          return res.sendStatus(200);
        }

        // Обработка завершения заявки
        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            await sendMessage(chatId, '❌ Только исполнители могут завершать заявки.');
            return res.sendStatus(200);
          }

          userStates[chatId] = { 
            stage: 'waiting_photo', 
            row: parseInt(data.split(':')[1]), 
            username, 
            messageId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [] 
          };
          await sendMessage(chatId, '📸 Пришлите фото выполненных работ');
          return res.sendStatus(200);
        }

        // Обработка ожидания поставки
        if (data.startsWith('wait:')) {
          if (!EXECUTORS.includes(username)) {
            await sendMessage(chatId, '❌ Только исполнители могут менять статус заявки.');
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
            await sendMessage(chatId, '❌ Только исполнители могут отменять заявки.');
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

      // Обработка обычных сообщений (завершение заявки)
      if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);

        try {
          // Этап 1: Получение фото
          if (state.stage === 'waiting_photo' && msg.photo) {
            const fileId = msg.photo.at(-1).file_id;
            const fileLink = await getTelegramFileUrl(fileId);

            state.photoUrl = fileLink;
            state.stage = 'waiting_sum';
            state.serviceMessages.push(msg.message_id);

            await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
            return res.sendStatus(200);
          }

          // Этап 2: Получение суммы
          if (state.stage === 'waiting_sum' && msg.text) {
            state.sum = msg.text;
            state.stage = 'waiting_comment';
            state.serviceMessages.push(msg.message_id);

            await sendMessage(chatId, '💬 Напишите комментарий');
            return res.sendStatus(200);
          }

          // Этап 3: Получение комментария и завершение
          if (state.stage === 'waiting_comment' && msg.text) {
            state.comment = msg.text;
            state.serviceMessages.push(msg.message_id);

            const completionData = {
              row: state.row,
              sum: state.sum,
              comment: state.comment,
              photoUrl: state.photoUrl,
              executor: state.username,
              originalRequest: state.originalRequest,
              delayDays: calculateDelayDays(state.originalRequest?.deadline)
            };

            // Отправка данных в GAS
            await sendToGAS({
              ...completionData,
              status: 'Выполнено'
            });

            // Формирование и отправка итогового сообщения
            const completionMessage = formatCompletionMessage(completionData);
            await editMessageSafe(chatId, state.messageId, completionMessage);

            // Обновление через 3 минуты с ссылкой на Google Disk
            setTimeout(async () => {
              try {
                const diskUrl = await getGoogleDiskLink(state.row);
                if (diskUrl) {
                  const updatedMessage = formatCompletionMessage({
                    ...completionData,
                    photoUrl: diskUrl
                  }, diskUrl);
                  await editMessageSafe(chatId, state.messageId, updatedMessage);
                }
              } catch (e) {
                console.error('Error updating disk link:', e);
              }
            }, 3 * 60 * 1000);

            // Удаление служебных сообщений через 1 минуту
            setTimeout(async () => {
              try {
                for (const msgId of state.serviceMessages) {
                  await deleteMessageSafe(chatId, msgId);
                }
                // Удаляем само сообщение с кнопками
                await deleteMessageSafe(chatId, state.messageId); 
              } catch (e) {
                console.error('Error deleting messages:', e);
              }
            }, 60 * 1000);

            delete userStates[chatId];
            return res.sendStatus(200);
          }
        } catch (e) {
          console.error('Error handling user message:', e);
          return res.sendStatus(500);
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(500);
    }
  });
};
