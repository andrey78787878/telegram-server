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
    const { row, executor, amount, photoUrl, originalMessageId } = state;
    const comment = commentText || '';

    const textRes = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row });
    const originalText = textRes.data?.text || '';

    const updatedText = `👷 Исполнитель: ${executor}
💰 Сумма: ${amount || '0'}
📸 Фото: <a href="${photoUrl}">ссылка</a>
📝 Комментарий: ${comment}

━━━━━━━━━━━━

${originalText}`;

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

        if (action === 'done') {
          userStates[chatId] = {
            ...userStates[chatId],
            stage: 'awaiting_photo',
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

          const updatedText = `${originalText}

⏳ Статус: Ожидает поставки`;
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

        if (state.stage === 'awaiting_photo' && message.photo) {
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
