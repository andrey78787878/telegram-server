// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const { google } = require('googleapis');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
  const DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

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

  async function uploadPhotoToDrive(fileUrl, fileName) {
    return fileUrl;
  }

  async function cleanupMessages(chatId, state) {
    const messages = [...(state.serviceMessages || []), ...(state.userResponses || [])];
    for (const msg of messages) {
      await deleteMessage(chatId, msg);
    }
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
            userStates[chatId].awaiting_manual_executor = true;
            userStates[chatId].stage = 'awaiting_manual_executor';
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].serviceMessages = [prompt];
            deleteMessageWithDelay(chatId, prompt);
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
            ...userStates[chatId],
            row,
            executor,
            originalMessageId,
            serviceMessages: []
          };
          return res.sendStatus(200);
        }

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
          await axios.post(GAS_WEB_APP_URL, { action: 'delayed', row, status: 'Ожидает поставки' });
          await editMessageText(chatId, messageId, message.text + '\n⏳ Ожидает поставки');
          return res.sendStatus(200);
        }

        if (action === 'cancelled') {
          await axios.post(GAS_WEB_APP_URL, { action: 'cancelled', row, status: 'Отменено' });
          await editMessageText(chatId, messageId, message.text + '\n❌ Отменено');
          return res.sendStatus(200);
        }
      }

      if (body.message) {
        const { message } = body;
        const chatId = message.chat.id;
        const state = userStates[chatId];

        if (state?.stage === 'awaiting_manual_executor' && message.text) {
          const executor = message.text;
          const row = state.row;
          const originalMessageId = state.sourceMessageId || state.originalMessageId;

          const [textRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);
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
          deleteMessageWithDelay(chatId, message.message_id);

          userStates[chatId] = {
            ...userStates[chatId],
            row,
            executor,
            originalMessageId,
            stage: null,
            serviceMessages: []
          };
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
