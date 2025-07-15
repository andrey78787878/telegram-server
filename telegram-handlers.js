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

    const [idRes, textRes, delayRes] = await Promise.all([
      axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getDelayInfo', row })
    ]);

    const originalMessageId = idRes.data?.message_id;
    const originalText = textRes.data?.text || '';
    const delayDays = delayRes.data?.delay || '0';

    if (!originalMessageId) return;

    const updatedText = `✅ Выполнено\n👷 Исполнитель: ${executor}\n💰 Сумма: ${amount || '0'}\n📸 Фото: <a href="${photoUrl}">ссылка</a>\n📝 Комментарий: ${comment || 'не указан'}\n🔴 Просрочка: ${delayDays} дн.\n\n━━━━━━━━━━━━\n\n${originalText}`;

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

    setTimeout(async () => {
      const finalRes = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row });
      const finalText = finalRes.data?.text || originalText;
      const driveUrlRes = await axios.post(GAS_WEB_APP_URL, { action: 'getDriveLink', row });
      const driveUrl = driveUrlRes.data?.driveUrl || photoUrl;
      const editedFinalText = `✅ Выполнено\n👷 Исполнитель: ${executor}\n💰 Сумма: ${amount || '0'}\n📸 Фото: <a href="${driveUrl}">ссылка</a>\n📝 Комментарий: ${comment || 'не указан'}\n🔴 Просрочка: ${delayDays} дн.\n\n━━━━━━━━━━━━\n\n${finalText}`;
      await editMessageText(chatId, originalMessageId, editedFinalText);
    }, 180000);
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

        if (action === 'in_progress') {
          const getRes = await axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row });
          const originalMessageId = getRes.data?.message_id;
          if (!originalMessageId) return res.sendStatus(200);
          const keyboard = buildExecutorButtons(row);
          await editMessageText(chatId, originalMessageId, `${message.text}\n\nВыберите исполнителя:`, keyboard);
          userStates[chatId] = { row, sourceMessageId: originalMessageId, serviceMessages: [] };
          return res.sendStatus(200);
        }

        if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = { row };
          if (executor === 'Текстовой подрядчик') {
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].awaiting_manual_executor = true;
            userStates[chatId].serviceMessages = [prompt];
            return res.sendStatus(200);
          }

          const [idRes, textRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);
          const originalMessageId = idRes.data?.message_id;
          const originalText = textRes.data?.text || '';
          if (!originalMessageId) return res.sendStatus(200);

          await axios.post(GAS_WEB_APP_URL, {
            action: 'in_progress',
            row,
            executor,
            message_id: originalMessageId
          });

          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
          const buttons = buildFinalButtons(row);

          await editMessageText(chatId, originalMessageId, updatedText, buttons);

          userStates[chatId] = {
            ...userStates[chatId],
            row,
            executor,
            originalMessageId,
            serviceMessages: []
          };
          return res.sendStatus(200);
        }

        // остальная логика (done, delayed, cancelled...) без изменений ↓
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('Ошибка в webhook:', error.message);
      res.sendStatus(500);
    }
  });
};
