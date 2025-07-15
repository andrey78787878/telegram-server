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

  async function getFileLink(fileId) {
    const file = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = file.data.result.file_path;
    return `${TELEGRAM_FILE_API}/${filePath}`;
  }

  async function uploadPhotoToDrive(fileUrl, fileName) {
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    const res = await axios.get(fileUrl, { responseType: 'stream' });
    const fileMeta = { name: fileName, parents: [DRIVE_FOLDER_ID] };
    const media = { mimeType: 'image/jpeg', body: res.data };
    const uploaded = await drive.files.create({ requestBody: fileMeta, media, fields: 'id' });
    const fileId = uploaded.data.id;
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    return `https://drive.google.com/uc?id=${fileId}`;
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
        const { data: raw, message, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const [action, row, executor] = raw.split(':');

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId
        });

        // 🔹 Обработка нажатия "Принято в работу"
        if (action === 'in_progress') {
          await editMessageText(chatId, messageId, message.text, { inline_keyboard: [] });
          const keyboard = buildExecutorButtons(row);
          const newText = `${message.text}\n\nВыберите исполнителя:`;
          await editMessageText(chatId, messageId, newText, keyboard);
          userStates[chatId] = { row, sourceMessageId: messageId, serviceMessages: [] };
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
          const rowDataRes = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestRow', row });
          const rowData = rowDataRes.data?.row;
          const originalMessageId = rowData?.[16];
          if (!originalMessageId || !rowData) return res.sendStatus(200);

          const formatDate = (val) => {
            const d = new Date(val);
            return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
          };

          const updatedText = `📍 Заявка #${row}

🍕 Пиццерия: ${rowData[1] || '—'}
🔧 Классификация: ${rowData[2] || '—'}
📂 Категория: ${rowData[3] || '—'}
📋 Проблема: ${rowData[4] || '—'}
👤 Инициатор: ${rowData[5] || '—'}
📞 Телефон: ${rowData[6] || '—'}
🕓 Срок: ${rowData[8] ? formatDate(rowData[8]) : '—'}

🟢 В работе
👷 Исполнитель: ${executor}`;

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
          await editMessageText(chatId, userStates[chatId].originalMessageId, '📌 Ожидаем фото...');
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
        // ... (остальной код без изменений)
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
