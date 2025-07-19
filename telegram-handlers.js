const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const MESSAGE_LIFETIME = 60000;
const MANAGERS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const EXECUTORS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];
const userStorage = new Map();
const userStates = {};

// Вспомогательные функции
function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  return parts.length > 1 ? parseInt(parts[1], 10) : null;
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
    if (line.includes('Проблема:')) result.problem = line.split(':')[1].trim();
    if (line.includes('Срок:')) result.deadline = line.split(':')[1].trim();
  });
  
  return result;
}

function formatInProgressMessage(row, requestData, executor) {
  return `
📌 Заявка #${row}
🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}
🔧 Проблема: ${requestData?.problem || 'не указано'}
🕓 Срок: ${requestData?.deadline || 'не указан'}
━━━━━━━━━━━━
🟢 В работе (исполнитель: ${executor})
  `.trim();
}

function formatCompletionMessage(data, photoUrl = null) {
  return `
✅ Заявка #${data.row} ${data.isEmergency ? '🚨 (АВАРИЙНАЯ)' : ''} закрыта
${photoUrl ? `\n📸 ${photoUrl}\n` : ''}
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
    console.error('Ошибка отправки сообщения:', error.response?.data);
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
    if (error.response?.data?.description?.includes('message to edit not found')) {
      return await sendMessage(chatId, text, options);
    }
    console.error('Ошибка редактирования сообщения:', error.response?.data);
    throw error;
  }
}

async function deleteMessageSafe(chatId, messageId) {
  try {
    return await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.error('Ошибка удаления сообщения:', error.response?.data);
    return null;
  }
}

async function sendToGAS(data) {
  try {
    const response = await axios.post(GAS_WEB_APP_URL, data);
    console.log('Данные отправлены в GAS:', response.data);
    return response.data;
  } catch (error) {
    console.error('Ошибка отправки в GAS:', error.message);
    throw error;
  }
}

async function notifyManagers(row, requestData) {
  const emergencyMessage = `
🚨🚨🚨 АВАРИЙНАЯ ЗАЯВКА #${row} 🚨🚨🚨
🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}
🔧 Проблема: ${requestData?.problem || 'не указано'}
🕓 Срок: ${requestData?.deadline || 'не указан'}
‼️ ТРЕБУЕТСЯ НЕМЕДЛЕННАЯ РЕАКЦИЯ!
  `.trim();

  for (const manager of MANAGERS) {
    const managerId = userStorage.get(manager);
    if (managerId) {
      await sendMessage(managerId, emergencyMessage, {
        disable_notification: false
      }).catch(console.error);
    }
  }
}

module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      
      // Сохраняем информацию о пользователе
      if (body.message?.from) {
        const user = body.message.from;
        if (user.username) {
          userStorage.set(`@${user.username}`, user.id);
        }
      }

      // Обработка callback-запросов
      if (body.callback_query) {
        const { callback_query } = body;
        const user = callback_query.from;
        const username = user.username ? `@${user.username}` : null;
        const chatId = callback_query.message.chat.id;
        const messageId = callback_query.message.message_id;
        const data = callback_query.data;
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(callback_query.message.text);

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callback_query.id
        }).catch(console.error);

        // Проверка прав доступа
        if (!AUTHORIZED_USERS.includes(username)) {
          const msg = await sendMessage(chatId, '❌ У вас нет доступа к этой операции');
          setTimeout(() => deleteMessageSafe(chatId, msg.data.result.message_id), 30000);
          return res.sendStatus(200);
        }

        // Обработка принятия в работу
        if (data === 'accept') {
          if (!MANAGERS.includes(username)) {
            const msg = await sendMessage(chatId, '❌ Только менеджеры могут принимать заявки');
            setTimeout(() => deleteMessageSafe(chatId, msg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          const isEmergency = callback_query.message.text?.includes('🚨');
          const requestData = parseRequestMessage(callback_query.message.text);

          // Обновляем сообщение в чате
          const updatedText = callback_query.message.text.replace('🚨', '') + 
            `\n\n🟢 Принята в работу (менеджер: ${username})`;

          await editMessageSafe(chatId, messageId, updatedText, {
            reply_markup: {
              inline_keyboard: [
                [{ text: 'Назначить исполнителя', callback_data: `assign:${row}` }]
              ]
            }
          });

          // Для аварийных - уведомляем менеджеров
          if (isEmergency) {
            await notifyManagers(row, requestData);
            await sendToGAS({
              row,
              status: 'Аварийная',
              isEmergency: true
            });
          } else {
            await sendToGAS({
              row,
              status: 'Принята в работу',
              manager: username
            });
          }

          return res.sendStatus(200);
        }

        // Назначение исполнителя
        if (data.startsWith('assign:')) {
          const buttons = EXECUTORS.map(executor => [{
            text: executor,
            callback_data: `set_executor:${executor}:${row}`
          }]);

          await editMessageSafe(chatId, messageId, 'Выберите исполнителя:', {
            reply_markup: { inline_keyboard: buttons }
          });

          return res.sendStatus(200);
        }

        // Установка исполнителя
        if (data.startsWith('set_executor:')) {
          const executor = data.split(':')[1];
          const requestData = parseRequestMessage(callback_query.message.text);
          const isEmergency = callback_query.message.text?.includes('🚨');

          // Обновляем сообщение в чате
          await editMessageSafe(chatId, messageId, formatInProgressMessage(row, requestData, executor), {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Выполнено', callback_data: `done:${row}` },
                  { text: '⏳ Ожидает', callback_data: `wait:${row}` },
                  { text: '❌ Отмена', callback_data: `cancel:${row}` }
                ]
              ]
            }
          });

          // Уведомляем исполнителя
          const executorId = userStorage.get(executor);
          if (executorId) {
            await sendMessage(executorId, `📌 Вам назначена заявка #${row}\n\n` +
              `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
              `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
              `🕓 Срок: ${requestData?.deadline || 'не указан'}`);
          }

          await sendToGAS({
            row,
            status: 'В работе',
            executor,
            isEmergency
          });

          return res.sendStatus(200);
        }

        // Завершение заявки
        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            const msg = await sendMessage(chatId, '❌ Только исполнители могут завершать заявки');
            setTimeout(() => deleteMessageSafe(chatId, msg.data.result.message_id), 30000);
            return res.sendStatus(200);
          }

          const requestData = parseRequestMessage(callback_query.message.text);
          const isEmergency = callback_query.message.text?.includes('🚨');

          userStates[chatId] = {
            stage: 'waiting_photo',
            row,
            username,
            messageId,
            originalRequest: requestData,
            isEmergency
          };

          await sendMessage(chatId, '📸 Пришлите фото выполненных работ', {
            reply_to_message_id: messageId
          });

          return res.sendStatus(200);
        }

        // Ожидание поставки
        if (data.startsWith('wait:')) {
          await sendToGAS({
            row,
            status: 'Ожидает поставки'
          });

          await editMessageSafe(chatId, messageId, callback_query.message.text + '\n\n⏳ Ожидает поставки');
          return res.sendStatus(200);
        }

        // Отмена заявки
        if (data.startsWith('cancel:')) {
          await sendToGAS({
            row,
            status: 'Отменено'
          });

          await editMessageSafe(chatId, messageId, callback_query.message.text + '\n\n❌ Отменена');
          return res.sendStatus(200);
        }
      }

      // Обработка фото и данных для завершения заявки
      if (body.message && userStates[body.message.chat.id]) {
        const chatId = body.message.chat.id;
        const state = userStates[chatId];
        const msg = body.message;

        if (state.stage === 'waiting_photo' && msg.photo) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          state.photoUrl = `${TELEGRAM_FILE_API}/${fileId}`;
          state.stage = 'waiting_sum';

          await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)', {
            reply_to_message_id: state.messageId
          });
          return res.sendStatus(200);
        }

        if (state.stage === 'waiting_sum' && msg.text) {
          state.sum = msg.text;
          state.stage = 'waiting_comment';

          await sendMessage(chatId, '💬 Введите комментарий', {
            reply_to_message_id: state.messageId
          });
          return res.sendStatus(200);
        }

        if (state.stage === 'waiting_comment' && msg.text) {
          state.comment = msg.text;

          const completionData = {
            row: state.row,
            status: 'Выполнено',
            sum: state.sum,
            comment: state.comment,
            photoUrl: state.photoUrl,
            executor: state.username,
            originalRequest: state.originalRequest,
            isEmergency: state.isEmergency
          };

          // Обновляем сообщение в чате
          await editMessageSafe(
            chatId,
            state.messageId,
            formatCompletionMessage(completionData),
            { disable_web_page_preview: false }
          );

          // Отправляем данные в Google Sheets
          await sendToGAS(completionData);

          // Очищаем состояние
          delete userStates[chatId];

          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Ошибка в обработчике webhook:', error);
      return res.status(500).send('Internal Server Error');
    }
  });
};
