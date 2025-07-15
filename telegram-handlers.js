// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');

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
        const { chat, text, photo, message_id } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];
        if (!state) return res.sendStatus(200);

        if (state.awaiting_manual_executor && text) {
          const rowDataRes = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestRow', row: state.row });
          const rowData = rowDataRes.data?.row;
          const originalMessageId = rowData?.[16];
          if (!originalMessageId || !rowData) return res.sendStatus(200);

          await axios.post(GAS_WEB_APP_URL, {
            action: 'in_progress', row: state.row, executor: text, message_id: originalMessageId
          });

          const updatedText = `📍 Заявка #${state.row}

🍕 Пиццерия: ${rowData[1] || '—'}
🔧 Классификация: ${rowData[2] || '—'}
📂 Категория: ${rowData[3] || '—'}
📋 Проблема: ${rowData[4] || '—'}
👤 Инициатор: ${rowData[5] || '—'}
📞 Телефон: ${rowData[6] || '—'}
🕓 Срок: ${rowData[8] ? (new Date(rowData[8])).toLocaleDateString('ru-RU') : '—'}

🟢 В работе
👷 Исполнитель: ${text}`;

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
          await cleanupMessages(chatId, state);

          userStates[chatId] = {
            ...state,
            executor: text,
            awaiting_manual_executor: false,
            originalMessageId,
            serviceMessages: []
          };
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_photo' && photo) {
          const photoFileId = photo[photo.length - 1].file_id;
          const fileUrl = await getFileLink(photoFileId);
          const fileName = `request_${state.row}_${Date.now()}.jpg`;
          const driveLink = await uploadPhotoToDrive(fileUrl, fileName);
          state.photoUrl = driveLink;
          state.userResponses.push(message_id);
          const prompt = await sendMessage(chatId, '💰 Введите сумму выполненной работы:');
          state.serviceMessages.push(prompt);
          state.stage = 'awaiting_amount';
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_amount' && text) {
          state.amount = text;
          state.userResponses.push(message_id);
          const prompt = await sendMessage(chatId, '📝 Введите комментарий к работе:');
          state.serviceMessages.push(prompt);
          state.stage = 'awaiting_comment';
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_comment' && text) {
          state.comment = text;
          state.userResponses.push(message_id);

          await axios.post(GAS_WEB_APP_URL, {
            action: 'complete',
            row: state.row,
            photoUrl: state.photoUrl,
            amount: state.amount,
            comment: state.comment,
            status: 'Выполнено',
            message_id: state.originalMessageId
          });

          const delayRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getRequestRow', row: state.row
          });

          const delay = delayRes?.data?.row?.[13] || '—';

          const finalText = `📌 Заявка #${state.row} закрыта.
📎 Фото: ${state.photoUrl}
💰 Сумма: ${state.amount} сум
👤 Исполнитель: ${state.executor}
✅ Статус: Выполнено
Просрочка: ${delay} дн.`;

          await editMessageText(chatId, state.originalMessageId, finalText);
          await cleanupMessages(chatId, state);
          delete userStates[chatId];
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
