const axios = require('axios');
const FormData = require('form-data');

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

// Права пользователей (актуальные юзернеймы)
const MANAGERS = ['@Andrey_Tkach_MB', '@Andrey_tkach_y'];
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85', '@Andrey_tkach_y'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

// Хранилища
const userStorage = new Map(); // username -> user_id
const userStates = {}; // chat_id -> state

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function extractRowFromMessage(text) {
  const match = text?.match(/#(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function parseRequestMessage(text) {
  const result = {};
  text?.split('\n').forEach(line => {
    if (line.includes('Пиццерия:')) result.pizzeria = line.split(':')[1].trim();
    if (line.includes('Проблема:')) result.problem = line.split(':')[1].trim();
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

// --- ОБРАБОТКА УВЕДОМЛЕНИЙ ---
async function handleExecutorNotification(executorUsername, row, requestText, chatId, messageId) {
  try {
    const executorId = userStorage.get(executorUsername);
    if (!executorId) throw new Error('ID исполнителя не найден');

    const requestData = parseRequestMessage(requestText);
    const isEmergency = requestText.includes('🚨');

    // 1. Уведомление исполнителю
    await sendMessage(
      executorId,
      `${isEmergency ? '🚨 ' : ''}📌 Вам назначена заявка #${row}\n\n` +
      `🍕 Пиццерия: ${requestData?.pizzeria || '—'}\n` +
      `🔧 Проблема: ${requestData?.problem || '—'}\n` +
      `🕓 Срок: ${requestData?.deadline || '—'}\n\n` +
      `${isEmergency ? '‼️ СРОЧНО ТРЕБУЕТСЯ РЕАКЦИЯ!' : '⚠️ Приступайте к выполнению'}`,
      { disable_notification: false }
    );

    // 2. Уведомление менеджеров для аварийных
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

    // 3. Подтверждение в чате
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

// --- ОБРАБОТКА ЗАКРЫТИЯ ЗАЯВКИ ---
async function handleRequestCompletion(chatId, messageId, row, username, photoUrl) {
  try {
    // 1. Обновляем сообщение в чате
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text: `✅ Заявка #${row} закрыта\nИсполнитель: ${username}\n${photoUrl ? `📸 Фото: ${photoUrl}` : ''}`,
      parse_mode: 'HTML'
    });

    // 2. Удаляем сервисные сообщения
    if (userStates[chatId]?.serviceMessages) {
      for (const msgId of userStates[chatId].serviceMessages) {
        await deleteMessageSafe(chatId, msgId);
      }
    }

    // 3. Отправка в GAS
    await axios.post(GAS_WEB_APP_URL, {
      row,
      status: 'Выполнено',
      executor: username,
      photoUrl
    });

    delete userStates[chatId];
  } catch (error) {
    console.error('Ошибка закрытия заявки:', error);
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
        const row = extractRowFromCallbackData(data) || extractRowFromMessage(msg.text);

        // Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          await sendMessage(chatId, '❌ У вас нет доступа');
          return res.sendStatus(200);
        }

        // Назначение исполнителя
        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
          await handleExecutorNotification(
            executorUsername,
            row,
            msg.text || msg.caption,
            chatId,
            messageId
          );
          
          // Обновление статуса в чате
          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: `${msg.text}\n\n🟢 В работе (исполнитель: ${executorUsername})`,
            parse_mode: 'HTML'
          });

          // Отправка в GAS
          await axios.post(GAS_WEB_APP_URL, {
            row,
            status: 'В работе',
            executor: executorUsername
          });
        }

        // Закрытие заявки
        if (data.startsWith('done:')) {
          if (!EXECUTORS.includes(username)) {
            await sendMessage(chatId, '❌ Только исполнители могут закрывать заявки');
            return res.sendStatus(200);
          }

          // Начинаем процесс закрытия
          const photoMsg = await sendMessage(chatId, '📸 Отправьте фото выполненных работ');
          userStates[chatId] = {
            stage: 'waiting_photo',
            row,
            username,
            messageId,
            originalRequest: parseRequestMessage(msg.text),
            serviceMessages: [photoMsg.result.message_id]
          };
        }
      }

      // Обработка сообщений (фото/комментарии)
      if (message && userStates[message.chat.id]) {
        const state = userStates[message.chat.id];
        
        // Получение фото
        if (state.stage === 'waiting_photo' && message.photo) {
          await deleteMessageSafe(message.chat.id, state.serviceMessages[0]);
          const fileId = message.photo[message.photo.length - 1].file_id;
          state.photoUrl = await getTelegramFileUrl(fileId);
          
          const sumMsg = await sendMessage(message.chat.id, '💰 Укажите сумму работ');
          state.stage = 'waiting_sum';
          state.serviceMessages = [sumMsg.result.message_id];
        }

        // Получение суммы
        if (state.stage === 'waiting_sum' && message.text) {
          await deleteMessageSafe(message.chat.id, state.serviceMessages[0]);
          state.sum = message.text;
          
          const commentMsg = await sendMessage(message.chat.id, '💬 Введите комментарий');
          state.stage = 'waiting_comment';
          state.serviceMessages = [commentMsg.result.message_id];
        }

        // Получение комментария
        if (state.stage === 'waiting_comment' && message.text) {
          await deleteMessageSafe(message.chat.id, state.serviceMessages[0]);
          state.comment = message.text;
          
          // Финализация заявки
          await handleRequestCompletion(
            message.chat.id,
            state.messageId,
            state.row,
            state.username,
            state.photoUrl
          );
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      res.sendStatus(500);
    }
  });
};
