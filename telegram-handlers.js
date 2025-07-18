const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const AUTHORIZED_USERS = [
  '@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85'
];

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

        // 1. Ответ Telegram
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callback_query.id
        }).catch(console.error);

        // 2. Логирование
        const messageContent = msg.text || msg.caption;
        console.log('Callback received:', { 
          username, 
          data, 
          source: msg.text ? 'text' : 'caption',
          content: messageContent,
          row: extractRowFromMessage(messageContent)
        });

        // 3. Проверка прав
        if (!AUTHORIZED_USERS.includes(username)) {
          await sendMessage(chatId, '❌ У вас нет доступа.');
          return res.sendStatus(200);
        }

        // 4. Извлечение номера заявки
        const row = extractRowFromMessage(messageContent);
        if (!row) {
          console.error('Не удалось извлечь номер заявки');
          return res.sendStatus(200);
        }

        // === Обработка "Принять в работу" ===
        if (data === 'accept') {
          await editMessage(chatId, messageId, `${messageContent}\n\n🟢 Заявка в работе`);

          const buttons = AUTHORIZED_USERS.map(e => [
            { text: e, callback_data: `executor:${e}:${row}` }
          ]);

          await sendMessage(chatId, '👷 Выберите исполнителя:', {
            reply_to_message_id: messageId
          });

          await sendButtons(chatId, messageId, buttons);
          return res.sendStatus(200);
        }

        // === Обработка выбора исполнителя ===
        if (data.startsWith('executor:')) {
          const executor = data.split(':')[1];

          await sendToGAS({
            row,
            status: 'В работе',
            executor,
            message_id: messageId,
          });

          await sendButtons(chatId, messageId, [
            [
              { text: '✅ Выполнено', callback_data: `done:${row}` },
              { text: '🕐 Ожидает поставки', callback_data: `wait:${row}` },
              { text: '❌ Отмена', callback_data: `cancel:${row}` },
            ]
          ]);

          return res.sendStatus(200);
        }

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

      // Обработка обычных сообщений
      if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);

        try {
          if (state.stage === 'waiting_photo' && msg.photo) {
            const fileId = msg.photo.at(-1).file_id;
            const fileLink = await getTelegramFileUrl(fileId);

            state.photoUrl = fileLink;
            state.stage = 'waiting_sum';
            state.serviceMessages.push(msg.message_id);

            await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
            return res.sendStatus(200);
          }

          if (state.stage === 'waiting_sum' && msg.text) {
            state.sum = msg.text;
            state.stage = 'waiting_comment';
            state.serviceMessages.push(msg.message_id);

            await sendMessage(chatId, '💬 Напишите комментарий');
            return res.sendStatus(200);
          }

          if (state.stage === 'waiting_comment' && msg.text) {
            state.comment = msg.text;
            state.serviceMessages.push(msg.message_id);

            const { row, sum, comment, photoUrl, username, messageId } = state;

            await sendToGAS({
              row, sum, comment, photo: photoUrl, status: 'Выполнено', executor: username
            });

            const summary = [
              `📌 Заявка #${row} закрыта.`,
              `📎 Фото: ${photoUrl}`,
              `💰 Сумма: ${sum} сум`,
              `👤 Исполнитель: ${username}`,
              `✅ Статус: Выполнено`,
              `🔄 Ссылка обновится через 3 минуты`,
              `💬 Комментарий: ${comment}`
            ].join('\n');

            await editMessage(chatId, messageId, summary);

            setTimeout(async () => {
              try {
                const diskUrl = await getGoogleDiskLink(row);
                const updatedSummary = [
                  `📌 Заявка #${row} закрыта.`,
                  `📎 Фото: ${diskUrl}`,
                  `💰 Сумма: ${sum} сум`,
                  `👤 Исполнитель: ${username}`,
                  `✅ Статус: Выполнено`,
                  `💬 Комментарий: ${comment}`
                ].join('\n');
                await editMessage(chatId, messageId, updatedSummary);
              } catch (e) {
                console.error('Error updating disk link:', e);
              }
            }, 3 * 60 * 1000);

            setTimeout(async () => {
              try {
                for (const msgId of state.serviceMessages) {
                  await deleteMessage(chatId, msgId);
                }
              } catch (e) {
                console.error('Error deleting service messages:', e);
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

  // Вспомогательные функции
  async function sendMessage(chatId, text, options = {}) {
    return axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
  }

  async function editMessage(chatId, messageId, text) {
    return axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML'
    });
  }

  async function deleteMessage(chatId, messageId) {
    return axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    }).catch(() => {});
  }

  async function sendButtons(chatId, messageId, buttons) {
    return axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons }
    });
  }

  async function getTelegramFileUrl(fileId) {
    const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    return `${TELEGRAM_FILE_API}/${data.result.file_path}`;
  }

  async function sendToGAS(data) {
    return axios.post(GAS_WEB_APP_URL, data);
  }

  async function getGoogleDiskLink(row) {
    try {
      const res = await axios.post(`${GAS_WEB_APP_URL}?getDiskLink=true`, { row });
      return res.data.diskLink || '🔗 [файл не найден]';
    } catch {
      return '🔗 [ошибка загрузки ссылки]';
    }
  }

  function extractRowFromMessage(text) {
    if (!text) return null;
    const match = text.match(/#(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }
};
