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

async function deleteServiceMessages(chatId, messageIds) {
  for (const msgId of messageIds) {
    try {
      await deleteMessageSafe(chatId, msgId);
    } catch (e) {
      console.error(`Не удалось удалить сообщение ${msgId}:`, e.response?.data);
    }
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

// Хранилище состояний
const userStates = {};

module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      
      // Обработка callback_query
      if (body.callback_query) {
        const { callback_query } = body;
        const msg = callback_query.message;
        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const username = callback_query.from.username ? `@${callback_query.from.username}` : null;
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
          await sendMessage(chatId, '❌ У вас нет доступа.');
          return res.sendStatus(200);
        }

        // Обработка выбора исполнителя
        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
          
          // Удаляем сообщение "Выберите исполнителя"
          if (msg.reply_to_message) {
            await deleteMessageSafe(chatId, msg.reply_to_message.message_id);
          }

          // Создаем новое сообщение о назначении
          const newText = `📍 Заявка #${row} закреплена за ${executorUsername}\n`
                        + `🟢 Статус: В работе`;
          const assignedMsg = await sendMessage(chatId, newText, {
            reply_to_message_id: messageId
          });

          // Сохраняем ID для будущего удаления
          userStates[chatId] = {
            serviceMessages: [assignedMsg.data.result.message_id],
            mainMessageId: messageId
          };

          // Отправляем уведомление исполнителю
          await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          // Обновляем кнопки
          const buttons = [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '🕐 Ожидает поставки', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` }
            ]
          ];
          await sendButtonsWithRetry(chatId, messageId, buttons);

          return res.sendStatus(200);
        }

        // Обработка завершения заявки
        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            await sendMessage(chatId, '❌ Только исполнители могут завершать заявки.');
            return res.sendStatus(200);
          }

          // Отправляем запросы и сохраняем их ID
          const photoMsg = await sendMessage(chatId, '📸 Пришлите фото выполненных работ');
          const sumMsg = await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
          const commentMsg = await sendMessage(chatId, '💬 Напишите комментарий');

          userStates[chatId] = {
            stage: 'waiting_photo',
            row: parseInt(data.split(':')[1]),
            username,
            messageId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [
              photoMsg.data.result.message_id,
              sumMsg.data.result.message_id,
              commentMsg.data.result.message_id
            ]
          };

          return res.sendStatus(200);
        }

        // Обработка других статусов (wait/cancel) ...
      }

      // Обработка обычных сообщений
      if (body.message && userStates[body.message.chat.id]) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const state = userStates[chatId];

        // Получение фото
        if (state.stage === 'waiting_photo' && msg.photo) {
          const fileId = msg.photo.at(-1).file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          state.stage = 'waiting_sum';
          return res.sendStatus(200);
        }

        // Получение суммы
        if (state.stage === 'waiting_sum' && msg.text) {
          state.sum = msg.text;
          state.stage = 'waiting_comment';
          return res.sendStatus(200);
        }

        // Получение комментария и завершение
        if (state.stage === 'waiting_comment' && msg.text) {
          state.comment = msg.text;

          // Удаляем служебные запросы
          await deleteServiceMessages(chatId, state.serviceMessages);

          // Формируем итоговое сообщение
          const completionData = {
            row: state.row,
            sum: state.sum,
            comment: state.comment,
            photoUrl: state.photoUrl,
            executor: state.username,
            originalRequest: state.originalRequest,
            delayDays: calculateDelayDays(state.originalRequest?.deadline)
          };

          await sendToGAS({
            ...completionData,
            status: 'Выполнено'
          });

          const completionMessage = formatCompletionMessage(completionData);
          await editMessageSafe(chatId, state.messageId, completionMessage);

          // Обновление ссылки через 3 минуты
          setTimeout(async () => {
            try {
              const diskUrl = await getGoogleDiskLink(state.row);
              if (diskUrl) {
                const updatedMessage = formatCompletionMessage(completionData, diskUrl);
                await editMessageSafe(chatId, state.messageId, updatedMessage);
              }
            } catch (e) {
              console.error('Error updating disk link:', e);
            }
          }, 180000);

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
