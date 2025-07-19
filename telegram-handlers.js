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

function formatRequestDetails(data) {
  return `
📍 Заявка #${data.row}
🍕 Пиццерия: ${data.pizzeria || 'не указано'}
🔧 Классификация: ${data.category || 'не указано'}
📂 Категория: ${data.category || 'не указано'}
📋 Проблема: ${data.problem || 'не указано'}
👤 Инициатор: ${data.initiator || 'не указано'}
📞 Телефон: ${data.phone || 'не указано'}
🕓 Срок: ${data.deadline || 'не указано'}
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

// Хранилище состояний
const userStates = {};

module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      console.log('Incoming webhook:', JSON.stringify(body, null, 2));
      
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

        console.log(`Callback received from ${username}:`, {
          chatId,
          messageId,
          callbackData: data,
          messageText: msg.text || msg.caption
        });

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

          const updatedText = `${msg.text || msg.caption}\n\n🟢 Заявка в работе`;
          await editMessageSafe(chatId, messageId, updatedText);

          const buttons = EXECUTORS.map(e => [
            { text: e, callback_data: `executor:${e}:${row}` }
          ]);

          const chooseExecutorMsg = await sendMessage(chatId, `👷 Выберите исполнителя для заявки #${row}:`, {
            reply_to_message_id: messageId
          });

          // Удаляем сообщение выбора исполнителя через 1 минуту
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

          // Обновляем основное сообщение
          const newText = `${msg.text || msg.caption}\n\n🟢 Заявка в работе (исполнитель: ${executorUsername})`;
          await editMessageSafe(chatId, messageId, newText);

          // Отправляем уведомление в чат
          await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          // Отправляем пуш в ЛС исполнителю
          try {
            const executorId = userStorage.get(executorUsername);
            if (executorId) {
              const requestData = parseRequestMessage(msg.text || msg.caption);
              await sendMessage(
                executorId,
                `Вам назначена заявка #${row}\n\n` +
                `${formatRequestDetails({...requestData, row})}\n\n` +
                `⚠️ Пожалуйста, приступайте к выполнению!`
              );
            }
          } catch (e) {
            console.error('Error sending PM to executor:', e);
          }

          // Обновляем кнопки
          const buttons = [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '🕐 Ожидает поставки', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` }
            ]
          ];
          await sendButtonsWithRetry(chatId, messageId, buttons);

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
            const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут завершать заявки.');
            setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          // Отправляем запрос на фото
          const photoMsg = await sendMessage(chatId, '📸 Пришлите фото выполненных работ');
          
          userStates[chatId] = {
            stage: 'waiting_photo',
            row: parseInt(data.split(':')[1]),
            username,
            messageId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [photoMsg.data.result.message_id]
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

        // Получение фото
        if (state.stage === 'waiting_photo' && msg.photo) {
          // Удаляем предыдущее сообщение
          await deleteServiceMessages(chatId, state.serviceMessages);
          
          const fileId = msg.photo.at(-1).file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          
          // Запрашиваем сумму
          const sumMsg = await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
          state.stage = 'waiting_sum';
          state.serviceMessages = [sumMsg.data.result.message_id];
          
          // Удаляем через минуту
          setTimeout(() => deleteMessageSafe(chatId, sumMsg.data.result.message_id), 60000);
          return res.sendStatus(200);
        }

        // Получение суммы
        if (state.stage === 'waiting_sum' && msg.text) {
          // Удаляем предыдущее сообщение
          await deleteServiceMessages(chatId, state.serviceMessages);
          
          state.sum = msg.text;
          
          // Запрашиваем комментарий
          const commentMsg = await sendMessage(chatId, '💬 Напишите комментарий');
          state.stage = 'waiting_comment';
          state.serviceMessages = [commentMsg.data.result.message_id];
          
          // Удаляем через минуту
          setTimeout(() => deleteMessageSafe(chatId, commentMsg.data.result.message_id), 60000);
          return res.sendStatus(200);
        }

        // Получение комментария
        if (state.stage === 'waiting_comment' && msg.text) {
          // Удаляем предыдущее сообщение
          await deleteServiceMessages(chatId, state.serviceMessages);
          
          state.comment = msg.text;

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

          await sendToGAS(completionData);

          // Обновляем основное сообщение
          const completionMessage = `
✅ Заявка #${state.row} завершена
👤 Исполнитель: ${state.username}
💰 Сумма: ${state.sum || '0'} сум
📸 Фото: ${state.photoUrl ? 'приложено' : 'отсутствует'}
💬 Комментарий: ${state.comment || 'нет'}
          `.trim();
          
          await editMessageSafe(chatId, state.messageId, completionMessage);

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
