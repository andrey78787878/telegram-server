const axios = require('axios');
const FormData = require('form-data');

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// Права пользователей
const MANAGERS = ['@EvelinaB87', '@Andrey_Tkach_MB', '@Davr_85'];
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Хранилища
const userStorage = new Map();
const userStates = {};

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  return parts.length > 2 ? parseInt(parts[2]) : null;
}

function extractRowFromMessage(text) {
  const match = text?.match(/#(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function parseRequestMessage(text) {
  const result = {};
  text?.split('\n').forEach(line => {
    if (line.includes('Пиццерия:')) result.pizzeria = line.split(':')[1].trim();
    if (line.includes('Категория:')) result.category = line.split(':')[1].trim();
    if (line.includes('Проблема:')) result.problem = line.split(':')[1].trim();
    if (line.includes('Инициатор:')) result.initiator = line.split(':')[1].trim();
    if (line.includes('Телефон:')) result.phone = line.split(':')[1].trim();
    if (line.includes('Срок:')) result.deadline = line.split(':')[1].trim();
  });
  return result;
}

async function sendMessage(chatId, text, options = {}) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
    return response.data;
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error.response?.data);
    throw error;
  }
}

async function deleteMessageSafe(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (error) {
    console.error('Ошибка удаления сообщения:', error.response?.data);
  }
}

async function getTelegramFileUrl(fileId) {
  try {
    const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    return `${TELEGRAM_FILE_API}/${data.result.file_path}`;
  } catch (error) {
    console.error('Ошибка получения URL файла:', error.response?.data);
    return null;
  }
}

async function sendToGAS(data) {
  try {
    const response = await axios.post(GAS_WEB_APP_URL, data);
    return response.data;
  } catch (error) {
    console.error('Ошибка отправки в GAS:', error.message);
    throw error;
  }
}

// --- ОБРАБОТКА УВЕДОМЛЕНИЙ ---
async function handleExecutorNotification(executorUsername, row, requestText, chatId, messageId) {
  try {
    const executorId = userStorage.get(executorUsername);
    if (!executorId) throw new Error('ID исполнителя не найден');

    const requestData = parseRequestMessage(requestText);
    const isEmergency = requestText.includes('🚨');

    await sendMessage(
      executorId,
      `${isEmergency ? '🚨 ' : ''}📌 Вам назначена заявка #${row}\n\n` +
      `🍕 Пиццерия: ${requestData?.pizzeria || '—'}\n` +
      `🔧 Проблема: ${requestData?.problem || '—'}\n` +
      `🕓 Срок: ${requestData?.deadline || '—'}\n\n` +
      `${isEmergency ? '‼️ СРОЧНО ТРЕБУЕТСЯ РЕАКЦИЯ!' : '⚠️ Приступайте к выполнению'}`,
      { disable_notification: false }
    );

    if (isEmergency) {
      for (const manager of MANAGERS) {
        if (manager === executorUsername) continue;
        const managerId = userStorage.get(manager);
        if (managerId) {
          await sendMessage(
            managerId,
            `🚨 АВАРИЙНАЯ ЗАЯВКА #${row}\nИсполнитель: ${executorUsername}\n` +
            `Пиццерия: ${requestData?.pizzeria || '—'}`,
            { disable_notification: false }
          );
        }
      }
    }

    await sendMessage(
      chatId,
      `✅ ${executorUsername} уведомлен о назначении`,
      { reply_to_message_id: messageId }
    );
  } catch (error) {
    console.error('Ошибка уведомления:', error);
    await sendMessage(
      chatId,
      `❌ Не удалось уведомить ${executorUsername}`,
      { reply_to_message_id: messageId }
    );
  }
}

// --- ОСНОВНОЙ WEBHOOK ---
module.exports = (app) => {
  app.post('/webhook', async (req, res) => {
    try {
      const { callback_query, message } = req.body;

      // Сохранение user_id
      const user = callback_query?.from || message?.from;
      if (user?.username) {
        userStorage.set(`@${user.username}`, user.id);
      }

      // Обработка callback_query
      if (callback_query) {
        const { data, message: msg, from } = callback_query;
        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const username = `@${from.username}`;
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(msg.text || msg.caption);

        if (!row) {
          console.error('Не удалось извлечь номер заявки');
          return res.sendStatus(200);
        }

        // Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          await sendMessage(chatId, '❌ У вас нет доступа');
          return res.sendStatus(200);
        }

        // Назначение исполнителя
        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
          await handleExecutorNotification(executorUsername, row, msg.text || msg.caption, chatId, messageId);
          
          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: `${msg.text || msg.caption}\n\n🟢 В работе (исполнитель: ${executorUsername})`,
            parse_mode: 'HTML'
          });

          await sendToGAS({
            row,
            status: 'В работе',
            executor: executorUsername,
            message_id: messageId
          });
        }

        // Закрытие заявки
        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            await sendMessage(chatId, '❌ Только исполнители могут закрывать заявки');
            return res.sendStatus(200);
          }

          const photoMsg = await sendMessage(chatId, '📸 Отправьте фото выполненных работ');
          userStates[chatId] = {
            stage: 'waiting_photo',
            row,
            username,
            messageId,
            originalRequest: parseRequestMessage(msg.text || msg.caption),
            serviceMessages: [photoMsg.result.message_id]
          };
        }
      }

      // Обработка сообщений
      if (message && userStates[message.chat.id]) {
        const state = userStates[message.chat.id];
        
        if (state.stage === 'waiting_photo' && message.photo) {
          await deleteMessageSafe(message.chat.id, state.serviceMessages[0]);
          const fileId = message.photo[message.photo.length - 1].file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          
          const sumMsg = await sendMessage(message.chat.id, '💰 Укажите сумму работ');
          state.stage = 'waiting_sum';
          state.serviceMessages = [sumMsg.result.message_id];
        }

        if (state.stage === 'waiting_sum' && message.text) {
          await deleteMessageSafe(message.chat.id, state.serviceMessages[0]);
          state.sum = message.text;
          
          const commentMsg = await sendMessage(message.chat.id, '💬 Введите комментарий');
          state.stage = 'waiting_comment';
          state.serviceMessages = [commentMsg.result.message_id];
        }

        if (state.stage === 'waiting_comment' && message.text) {
          await deleteMessageSafe(message.chat.id, state.serviceMessages[0]);
          state.comment = message.text;
          
          const completionData = {
            row: state.row,
            sum: state.sum,
            comment: state.comment,
            photoUrl: state.photoUrl,
            executor: state.username,
            originalRequest: state.originalRequest,
            status: 'Выполнено'
          };

          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: message.chat.id,
            message_id: state.messageId,
            text: `✅ Заявка #${state.row} закрыта\n` +
                  `👤 Исполнитель: ${state.username}\n` +
                  `💰 Сумма: ${state.sum || '0'} сум\n` +
                  `💬 Комментарий: ${state.comment || 'нет комментария'}\n` +
                  `${state.photoUrl ? '📸 Фото: ' + state.photoUrl + '\n' : ''}` +
                  `━━━━━━━━━━━━\n` +
                  `🏢 Пиццерия: ${state.originalRequest?.pizzeria || 'не указано'}\n` +
                  `🔧 Проблема: ${state.originalRequest?.problem || 'не указано'}`,
            parse_mode: 'HTML'
          });

          await sendToGAS(completionData);
          delete userStates[message.chat.id];
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      res.sendStatus(500);
    }
  });
};
