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

// Хранилище соответствия username → user_id
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

      // Обработка callback_query (кнопки)
      if (body.callback_query) {
        const { callback_query } = body;
        const user = callback_query.from;
        
        // Сохраняем user_id
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

        // === Обработка "Принять в работу" ===
        if (data === 'accept') {
          // Проверка прав (только MANAGERS)
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

        // === Обработка выбора исполнителя ===
        if (data.startsWith('executor:')) {
          const executorUsername = data.split(':')[1];
          
          // Обновляем текст сообщения
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

          // Уведомление в чат
          await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          // Уведомление в ЛС исполнителю
          try {
            const executorId = userStorage.get(executorUsername);
            if (executorId) {
              await sendMessage(
                executorId,
                `📌 Вам назначена заявка #${row}\n\n` +
                `${originalText}\n\n` +
                `⚠️ Пожалуйста, приступайте к выполнению!`
              );
            } else {
              console.error('Не удалось найти ID исполнителя:', executorUsername);
              await sendMessage(
                chatId,
                `${executorUsername}, проверьте ЛС с ботом! Вам назначена заявка #${row}`,
                { reply_to_message_id: messageId }
              );
            }
          } catch (e) {
            console.error('Ошибка уведомления исполнителя:', e);
          }

          // Обновляем кнопки (доступны для EXECUTORS)
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

        // === Обработка завершения заявки ===
        if (data.startsWith('done:')) {
          // Проверка прав (только EXECUTORS)
          if (!EXECUTORS.includes(username)) {
            await sendMessage(chatId, '❌ Только исполнители могут менять статус заявки.');
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

        // ... (аналогично для wait: и cancel:)
      }

      // Обработка обычных сообщений (завершение заявки)
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

  // ... (вспомогательные функции formatCompletionMessage, parseRequestMessag
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
