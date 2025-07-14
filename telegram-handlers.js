// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

  function buildExecutorButtons(row) {
    return {
      inline_keyboard: EXECUTORS.map(ex => [
        { text: ex, callback_data: `select_executor:${row}:${ex}` }
      ])
    };
  }

  async function sendMessage(chatId, text, options = {}) {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
    return res.data.result.message_id;
  }

  async function editMessageText(chatId, messageId, text, reply_markup) {
    try {
      const updatedText = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text: updatedText,
        parse_mode: 'HTML',
        ...(reply_markup && { reply_markup })
      });
    } catch (error) {
      console.error(`Ошибка изменения сообщения:`, error.message);
    }
  }

  async function deleteMessage(chatId, msgId) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
    } catch (e) {
      console.warn(`Не удалось удалить сообщение:`, e.message);
    }
  }

  async function cleanupServiceMessages(chatId, state) {
    if (state.serviceMessages?.length) {
      await Promise.all(state.serviceMessages.map(msgId => 
        deleteMessage(chatId, msgId).catch(console.error)
      ));
    }
  }

  async function handlePhoto(chatId, photo, state) {
    try {
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length - 1].file_id}`);
      const filePath = fileRes.data.result.file_path;
      state.photoUrl = `${TELEGRAM_FILE_API}/${filePath}`;

      const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
      state.serviceMessages.push(prompt);
      state.stage = 'awaiting_amount';
      
    } catch (error) {
      await sendMessage(chatId, '⚠️ Ошибка при обработке фото. Попробуйте еще раз.');
    }
  }

  async function handleAmount(chatId, amount, state) {
    try {
      state.amount = amount;
      const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
      state.serviceMessages.push(prompt);
      state.stage = 'awaiting_comment';
    } catch (error) {
      await sendMessage(chatId, '⚠️ Ошибка. Попробуйте еще раз.');
    }
  }

  async function completeRequest(chatId, state) {
    try {
      const originalTextRes = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row: state.row
      });
      
      const originalText = originalTextRes.data?.text || '';
      
      const updatedText = `✅ Выполнено
👷 Исполнитель: ${state.executor}
💰 Сумма: ${state.amount}
📸 Фото: ${state.photoUrl}
📝 Комментарий: ${state.comment || 'не указан'}

━━━━━━━━━━━━

${originalText}`;

      await axios.post(GAS_WEB_APP_URL, {
        action: 'complete',
        row: state.row,
        photoUrl: state.photoUrl,
        amount: state.amount,
        comment: state.comment,
        message_id: state.originalMessageId
      });

      await editMessageText(chatId, state.originalMessageId, updatedText);
      await cleanupServiceMessages(chatId, state);
      delete userStates[chatId];
      
    } catch (error) {
      await sendMessage(chatId, '⚠️ Ошибка при завершении заявки.');
    }
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { 
          callback_query_id: callbackId 
        }).catch(console.error);

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        if (action === 'in_progress') {
          await editMessageText(chatId, messageId, message.text, { inline_keyboard: [] });
          const keyboard = buildExecutorButtons(row);
          const newText = `${message.text}\n\nВыберите исполнителя:`;
          await editMessageText(chatId, messageId, newText, keyboard);
          userStates[chatId] = { row, sourceMessageId: messageId, serviceMessages: [] };
          return res.sendStatus(200);
        }

        if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = {};

          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages.push(prompt);
            return res.sendStatus(200);
          }

          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) return res.sendStatus(200);

          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row, 
            executor, 
            message_id: originalMessageId 
          });

          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
          const buttons = {
            inline_keyboard: [
              [
                { text: '✅ Выполнено', callback_data: `done:${row}` },
                { text: '⏳ Ожидает поставки', callback_data: `delayed:${row}` },
                { text: '❌ Отмена', callback_data: `cancelled:${row}` }
              ]
            ]
          };

          await editMessageText(chatId, originalMessageId, updatedText, buttons);
          if (originalMessageId !== messageId) {
            await editMessageText(chatId, messageId, message.text);
          }

          userStates[chatId] = {
            ...userStates[chatId],
            executor,
            sourceMessageId: originalMessageId,
            originalMessageId
          };

          return res.sendStatus(200);
        }

        if (action === 'done') {
          const originalIdRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getMessageId',
            row
          });
          const originalMessageId = originalIdRes.data?.message_id;

          if (!originalMessageId) return res.sendStatus(200);

          userStates[chatId] = {
            ...(userStates[chatId] || {}),
            row,
            stage: 'awaiting_photo',
            originalMessageId,
            serviceMessages: []
          };

          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения:');
          userStates[chatId].serviceMessages.push(prompt);
          await editMessageText(chatId, originalMessageId, '📌 Ожидаем фото...');

          return res.sendStatus(200);
        }

        if (action === 'delayed') {
          await axios.post(GAS_WEB_APP_URL, { action: 'delayed', row });
          const updatedText = `${message.text}\n\n⏳ Ожидает поставки`;
          await editMessageText(chatId, messageId, updatedText);
          return res.sendStatus(200);
        }

        if (action === 'cancelled') {
          await axios.post(GAS_WEB_APP_URL, { action: 'cancelled', row });
          const updatedText = `${message.text}\n\n❌ Отменено`;
          await editMessageText(chatId, messageId, updatedText);
          return res.sendStatus(200);
        }
      }

      if (body.message) {
        const { chat, message_id, text, photo, from } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);

        if (state.awaiting_manual_executor) {
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row: state.row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row: state.row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) return res.sendStatus(200);

          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row: state.row, 
            executor: text, 
            message_id: originalMessageId 
          });

          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${text}`;
          const buttons = {
            inline_keyboard: [
              [
                { text: '✅ Выполнено', callback_data: `done:${state.row}` },
                { text: '⏳ Ожидает поставки', callback_data: `delayed:${state.row}` },
                { text: '❌ Отмена', callback_data: `cancelled:${state.row}` }
              ]
            ]
          };

          await editMessageText(chatId, originalMessageId, updatedText, buttons);
          await cleanupServiceMessages(chatId, state);

          userStates[chatId] = {
            ...state,
            executor: text,
            sourceMessageId: originalMessageId,
            originalMessageId,
            awaiting_manual_executor: false
          };

          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_photo' && photo) {
          await handlePhoto(chatId, photo, state);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_amount') {
          await handleAmount(chatId, text, state);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_comment') {
          state.comment = text;
          await completeRequest(chatId, state);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_photo' && text) {
          await sendMessage(chatId, 'Пожалуйста, пришлите фото.');
          return res.sendStatus(200);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
