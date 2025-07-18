const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const AUTHORIZED_USERS = [
  '@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85'
];

// Функция для отправки данных в Google Apps Script
async function sendToGAS(data) {
  try {
    const response = await axios.post(GAS_WEB_APP_URL, data);
    console.log('📤 Данные отправлены в GAS:', response.status);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка при отправке в GAS:', error.message);
    throw error;
  }
}

module.exports = (app, userStates) => {
  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      
      // Обработка callback_query (кнопки)
      if (body.callback_query) {
        const { callback_query } = body;
        
        if (!callback_query || !callback_query.message || !callback_query.data || !callback_query.from) {
          return res.sendStatus(200);
        }

        const msg = callback_query.message;
        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const username = callback_query.from.username ? `@${callback_query.from.username}` : null;
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

        console.log('Callback received:', { 
          username, 
          data, 
          row
        });

        // Проверка прав доступа
        if (!AUTHORIZED_USERS.includes(username)) {
          await sendMessage(chatId, '❌ У вас нет доступа.');
          return res.sendStatus(200);
        }

        // === Обработка "Принять в работу" ===
        if (data === 'accept') {
          const updatedText = `${msg.text || msg.caption}\n\n🟢 Заявка в работе`;
          await editMessageSafe(chatId, messageId, updatedText);

          const buttons = AUTHORIZED_USERS.map(e => [
            { text: e, callback_data: `executor:${e}:${row}` }
          ]);

          await sendMessage(chatId, `👷 Выберите исполнителя для заявки #${row}:`, {
            reply_to_message_id: messageId
          });

          await sendButtonsWithRetry(chatId, messageId, buttons, `Выберите исполнителя для заявки #${row}:`);
          return res.sendStatus(200);
        }

        // === Обработка выбора исполнителя ===
        if (data.startsWith('executor:')) {
          const executor = data.split(':')[1];
          const executorUsername = executor.startsWith('@') ? executor : `@${executor}`;

          // Обновляем текст сообщения с информацией об исполнителе
          const originalText = msg.text || msg.caption;
          const updatedText = `${originalText}\n\n👤 Исполнитель: ${executorUsername}\n🟢 Заявка в работе`;
          
          await editMessageSafe(chatId, messageId, updatedText);

          // Отправляем данные в GAS
          await sendToGAS({
            row,
            status: 'В работе',
            executor: executorUsername,
            message_id: messageId,
          });

          // Отправляем уведомление исполнителю
          try {
            const userId = callback_query.from.id;
            await sendMessage(
              userId, 
              `📌 Вам назначена заявка #${row}\n\n` +
              `${originalText}\n\n` +
              `⚠️ Пожалуйста, приступайте к выполнению!`
            );
          } catch (e) {
            console.error('Не удалось отправить уведомление исполнителю:', e);
          }

          // Обновляем кнопки
          const buttons = [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '🕐 Ожидает поставки', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` },
            ]
          ];
          
          await sendButtonsWithRetry(chatId, messageId, buttons, `Заявка #${row} в работе`);
          return res.sendStatus(200);
        }

        // ... (остальная обработка done/wait/cancel остается без изменений)
        if (data.startsWith('done:')) {
          userStates[chatId] = { 
            stage: 'waiting_photo', 
            row: parseInt(data.split(':')[1]), 
            username, 
            messageId, 
            serviceMessages: [] 
          };
          await sendMessage(chatId, '📸 Пришлите фото выполненных работ');
          return res.sendStatus(200);
        }

        if (data.startsWith('wait:')) {
          await sendMessage(chatId, '⏳ Заявка переведена в статус "Ожидает поставки"', { 
            reply_to_message_id: messageId 
          });
          await sendToGAS({ 
            row: parseInt(data.split(':')[1]), 
            status: 'Ожидает поставки' 
          });
          return res.sendStatus(200);
        }

        if (data.startsWith('cancel:')) {
          await sendMessage(chatId, '🚫 Заявка отменена', { 
            reply_to_message_id: messageId 
          });
          await sendToGAS({ 
            row: parseInt(data.split(':')[1]), 
            status: 'Отменено' 
          });
          return res.sendStatus(200);
        }

        return res.sendStatus(200);
      }

      // Обработка обычных сообщений (остается без изменений)
      if (body.message) {
        // ... (существующая обработка сообщений)
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(500);
    }
  });

  // Вспомогательные функции

  function extractRowFromCallbackData(callbackData) {
    const match = callbackData.match(/:(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }

  function extractRowFromMessage(text) {
    if (!text) return null;
    const match = text.match(/#(\d+)/);
    return match ? parseInt(match[1], 10) : null;
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

  // ... (остальные вспомогательные функции)

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
      return await axios.post(GAS_WEB_APP_URL, data);
    } catch (error) {
      console.error('Send to GAS error:', error.response?.data);
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

  function extractRowFromMessage(text) {
    if (!text) return null;
    const match = text.match(/#(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }
};
