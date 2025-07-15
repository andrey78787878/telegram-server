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

  function buildFinalButtons(row) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Выполнено', callback_data: `done:${row}` },
          { text: '❌ Отмена', callback_data: `cancelled:${row}` }
        ]
      ]
    };
  }

  async function sendMessage(chatId, text, options = {}) {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
    console.log(`📤 Отправлено сообщение: ${text}`);
    return res.data.result.message_id;
  }

  async function editMessageText(chatId, messageId, text, reply_markup) {
    try {
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...(reply_markup && { reply_markup })
      });
    } catch (error) {
      const desc = error.response?.data?.description || error.message;
      if (!desc.includes('message is not modified')) {
        console.error(`❌ Ошибка изменения сообщения ${messageId}:`, desc);
      }
    }
  }

  async function deleteMessage(chatId, msgId) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
    } catch (e) {
      console.warn(`⚠️ Не удалось удалить сообщение ${msgId}:`, e.message);
    }
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function deleteMessageWithDelay(chatId, msgId, delayMs = 15000) {
    await delay(delayMs);
    await deleteMessage(chatId, msgId);
  }

  async function getFileLink(fileId) {
    const file = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = file.data.result.file_path;
    return `${TELEGRAM_FILE_API}/${filePath}`;
  }

  async function cleanupMessages(chatId, state) {
    const messages = [...(state.serviceMessages || []), ...(state.userResponses || [])];
    for (const msg of messages) {
      await deleteMessage(chatId, msg);
    }
  }

  async function completeRequest(chatId, state, commentMessageId, commentText) {
    const { row, executor, amount, photoUrl } = state;
    const comment = commentText || '';

    const idRes = await axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row });
    const originalMessageId = idRes.data?.message_id;
    if (!originalMessageId) return;

    const textRes = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row });
    const originalText = textRes.data?.text || '';

    const updatedText = `✅ Выполнено\n👷 Исполнитель: ${executor}\n💰 Сумма: ${amount || '0'}\n📸 Фото: ссылка\n📝 Комментарий: ${comment || 'не указан'}\n\n━━━━━━━━━━━━\n\n${originalText}`;

    await axios.post(GAS_WEB_APP_URL, {
      action: 'complete',
      row,
      status: 'Выполнено',
      photoUrl,
      amount,
      comment,
      message_id: originalMessageId
    });

    await editMessageText(chatId, originalMessageId, updatedText);
    await deleteMessageWithDelay(chatId, commentMessageId);
    await cleanupMessages(chatId, state);
    delete userStates[chatId];
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      if (body.callback_query) {
        const { data: raw, message, id: callbackId, from } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const [action, row, executor] = raw.split(':');

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId
        });

        if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = {};

          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            userStates[chatId].row = row;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            return res.sendStatus(200);
          }

          const [idRes, textRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = idRes.data?.message_id;
          const originalText = textRes.data?.text || '';

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

          userStates[chatId] = {
            executor,
            row,
            sourceMessageId: originalMessageId,
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };

          return res.sendStatus(200);
        }

        if (action === 'done') {
          const idRes = await axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row });
          const originalMessageId = idRes.data?.message_id;
          if (!originalMessageId) return res.sendStatus(200);

          userStates[chatId] = {
            ...userStates[chatId],
            stage: 'awaiting_photo',
            row,
            originalMessageId,
            serviceMessages: [],
            userResponses: []
          };

          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения:');
          userStates[chatId].serviceMessages.push(prompt);
          deleteMessageWithDelay(chatId, prompt);
          return res.sendStatus(200);
        }

        if (action === 'delayed') {
          await axios.post(GAS_WEB_APP_URL, {
            action: 'delayed',
            row,
            status: 'Ожидает поставки'
          });

          const textRes = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row });
          const originalText = textRes.data?.text || '';

          const updatedText = `${originalText}\n\n⏳ Статус: Ожидает поставки`;
          const finalButtons = buildFinalButtons(row);

          await editMessageText(chatId, messageId, updatedText, finalButtons);
          return res.sendStatus(200);
        }
      }

      if (body.message) {
        const { message } = body;
        const chatId = message.chat.id;
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);

        if (state.awaiting_manual_executor && message.text) {
          const text = message.text.trim();
          const row = state.row;

          const [idRes, textRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = idRes.data?.message_id;
          const originalText = textRes.data?.text || '';

          await axios.post(GAS_WEB_APP_URL, {
            action: 'in_progress',
            row,
            executor: text,
            message_id: originalMessageId
          });

          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${text}`;
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

          await deleteMessageWithDelay(chatId, message.message_id);

          userStates[chatId] = {
            executor: text,
            row,
            originalMessageId,
            awaiting_manual_executor: false,
            serviceMessages: [],
            userResponses: []
          };

          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_photo' && message.photo) {
          if (state.photoUrl) return res.sendStatus(200);
          const photoUrl = await getFileLink(message.photo.at(-1).file_id);
          state.photoUrl = photoUrl;
          state.userResponses.push(message.message_id);
          console.log(`📸 Получено фото от пользователя: ${photoUrl}`);

          const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
          state.stage = 'awaiting_amount';
          state.serviceMessages.push(prompt);
          deleteMessageWithDelay(chatId, prompt);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_amount' && message.text) {
          if (state.amount) return res.sendStatus(200);
          state.amount = message.text.trim();
          state.userResponses.push(message.message_id);
          console.log(`💰 Получена сумма от пользователя: ${state.amount}`);

          const prompt = await sendMessage(chatId, '📝 Добавьте комментарий:');
          state.stage = 'awaiting_comment';
          state.serviceMessages.push(prompt);
          deleteMessageWithDelay(chatId, prompt);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_comment' && message.text) {
          state.userResponses.push(message.message_id);
          console.log(`📝 Получен комментарий от пользователя: ${message.text}`);
          await completeRequest(chatId, state, message.message_id, message.text);
          return res.sendStatus(200);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
