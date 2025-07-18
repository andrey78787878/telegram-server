module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
  const AUTHORIZED_USERS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB'];

  // Удаление сообщений через 60 сек
  const scheduleDeletion = (chatId, messageId) => {
    setTimeout(() => {
      axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: messageId
      }).catch(() => {});
    }, 60000);
  };

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      // 📍 Вариант 1: Сообщение от пользователя
      if (body.message) {
        const msg = body.message;
        const chat = msg.chat;
        const chatId = chat.id;
        const text = msg.text;
        const username = msg.from?.username ? `@${msg.from.username}` : '';
        const state = userStates[chatId];

        if (text === '/start') {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: '👋 Добро пожаловать! Я помогу вам управлять заявками.'
          });
          return res.sendStatus(200);
        }

        if (text === '/мои') {
          if (chat.type !== 'private') {
            await axios.post(`${TELEGRAM_API}/sendMessage`, {
              chat_id: chatId,
              text: '👋 Пожалуйста, напишите эту команду в личку боту, чтобы увидеть свои заявки.',
            });
            return res.sendStatus(200);
          }
          const response = await axios.post(`${GAS_WEB_APP_URL}`, {
            type: 'getMyTasks',
            username
          });
          const text = response.data.text || 'Нет активных заявок.';
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'HTML'
          });
          return res.sendStatus(200);
        }

        if (!AUTHORIZED_USERS.includes(username)) {
          return res.sendStatus(200);
        }

        // Фото (если ожидается)
        if (msg.photo && state?.step === 'awaitingPhoto') {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
          const filePath = fileRes.data.result.file_path;
          const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

          userStates[chatId].photo = fileUrl;
          userStates[chatId].step = 'awaitingSum';

          const sumPrompt = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: '💰 Введите сумму выполненных работ (в сумах):'
          });
          scheduleDeletion(chatId, msg.message_id);
          scheduleDeletion(chatId, sumPrompt.data.result.message_id);
          return res.sendStatus(200);
        }

        // Сумма
        if (state?.step === 'awaitingSum' && text) {
          userStates[chatId].sum = text;
          userStates[chatId].step = 'awaitingComment';

          const commentPrompt = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: '📝 Добавьте комментарий:'
          });
          scheduleDeletion(chatId, msg.message_id);
          scheduleDeletion(chatId, commentPrompt.data.result.message_id);
          return res.sendStatus(200);
        }

        // Комментарий и завершение
        if (state?.step === 'awaitingComment' && text) {
          userStates[chatId].comment = text;
          const { row, message_id, photo, sum, comment } = userStates[chatId];

          const response = await axios.post(`${GAS_WEB_APP_URL}`, {
            type: 'done',
            row,
            sum,
            photo,
            comment,
            username,
            message_id
          });

          const updatedText = response.data.updated_text;
          const fileLink = response.data.photo_drive_link;
          const overdue = response.data.overdue || '0';
          const finalMessage = `
📌 Заявка #${row} закрыта.
📎 Фото: [ссылка](${fileLink})
💰 Сумма: ${sum} сум
👤 Исполнитель: ${username}
✅ Статус: Выполнено
⏰ Просрочка: ${overdue} дн.
📝 Комментарий: ${comment}`;

          // Обновляем сообщение
          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: chatId,
            message_id,
            text: finalMessage,
            parse_mode: 'Markdown'
          });

          delete userStates[chatId];
          scheduleDeletion(chatId, msg.message_id);
          return res.sendStatus(200);
        }

        return res.sendStatus(200);
      }

      // 📍 Вариант 2: Callback от кнопок
      if (body.callback_query) {
        const callback = body.callback_query;
        const data = callback.data;
        const chatId = callback.message.chat.id;
        const messageId = callback.message.message_id;
        const username = callback.from?.username ? `@${callback.from.username}` : '';

        if (!AUTHORIZED_USERS.includes(username)) {
          await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: callback.id,
            text: '⛔ У вас нет прав.',
            show_alert: true
          });
          return res.sendStatus(200);
        }

        const rowMatch = callback.message.text.match(/#(\d+)/);
        const row = rowMatch ? rowMatch[1] : null;
        if (!row) return res.sendStatus(200);

        // Отметка "Принято в работу"
        if (data === 'in_progress') {
          await axios.post(`${GAS_WEB_APP_URL}`, {
            type: 'inProgress',
            row,
            username,
            message_id: messageId
          });

          await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Выполнено', callback_data: 'done' },
                { text: '🚚 Ожидает поставки', callback_data: 'wait' },
                { text: '❌ Отмена', callback_data: 'cancel' }
              ]]
            }
          });

          await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: callback.id,
            text: '🟢 Заявка принята в работу.'
          });
          return res.sendStatus(200);
        }

        // Выполнено
        if (data === 'done') {
          userStates[chatId] = { step: 'awaitingPhoto', row, message_id: messageId };
          const prompt = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: '📸 Пришлите фото выполненных работ:'
          });
          scheduleDeletion(chatId, prompt.data.result.message_id);
          return res.sendStatus(200);
        }

        // Отмена
        if (data === 'cancel') {
          await axios.post(`${GAS_WEB_APP_URL}`, {
            type: 'cancel',
            row
          });
          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: `⛔ Заявка #${row} отменена.`
          });
          return res.sendStatus(200);
        }

        // Поставка
        if (data === 'wait') {
          await axios.post(`${GAS_WEB_APP_URL}`, {
            type: 'wait',
            row,
            username
          });
          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: `🚚 Заявка #${row} ожидает поставки.\n👤 ${username}`
          });
          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
