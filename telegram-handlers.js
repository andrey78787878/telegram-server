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

      console.log(`📝 Пытаемся изменить сообщение ${messageId}`);
      console.log('➡️ Новый текст:', updatedText);
      console.log('➡️ Новые кнопки:', JSON.stringify(reply_markup, null, 2));

      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text: updatedText,
        parse_mode: 'HTML',
        ...(reply_markup && { reply_markup })
      });
      console.log(`✏️ Изменено сообщение ${messageId} в чате ${chatId}`);
    } catch (error) {
      const desc = error.response?.data?.description || error.message;
      if (desc.includes('message is not modified')) {
        console.log(`ℹ️ Сообщение ${messageId} не изменено (тот же текст/markup)`);
      } else {
        console.error(`❌ Ошибка изменения сообщения ${messageId}:`, error.response?.data || error.message);
      }
    }
  }

  async function deleteMessage(chatId, msgId, finalId) {
    if (msgId === finalId) return;
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
      console.log(`🗑️ Удалено сообщение: ${msgId}`);
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
    const { google } = require('googleapis');
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

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      if (body.callback_query) {
        // [обработка колбэков остаётся прежней]
        // ...
        return res.sendStatus(200);
      }

      if (body.message) {
        const chatId = body.message.chat.id;
        const msg = body.message;
        const state = userStates[chatId];
        if (!state) return res.sendStatus(200);

        console.log('📥 Получено обычное сообщение от пользователя');

        const cleanup = async () => {
          for (const msgId of state.serviceMessages || []) {
            await deleteMessage(chatId, msgId, state.originalMessageId);
          }
        };

        if (state.stage === 'awaiting_photo' && msg.photo) {
          const photo = msg.photo[msg.photo.length - 1];
          const fileUrl = await getFileLink(photo.file_id);
          const fileName = `row-${state.row}-${Date.now()}.jpg`;
          const driveUrl = await uploadPhotoToDrive(fileUrl, fileName);

          userStates[chatId].photoUrl = driveUrl;
          userStates[chatId].stage = 'awaiting_sum';

          await cleanup();
          const prompt = await sendMessage(chatId, '💰 Введите сумму работ в сумах:', {
            reply_to_message_id: state.originalMessageId
          });
          userStates[chatId].serviceMessages = [prompt];
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_sum' && msg.text) {
          const sum = msg.text.trim();
          if (!/^\d+$/.test(sum)) {
            const warn = await sendMessage(chatId, '❗ Введите только сумму цифрами.');
            userStates[chatId].serviceMessages.push(warn);
            return res.sendStatus(200);
          }
          userStates[chatId].sum = sum;
          userStates[chatId].stage = 'awaiting_comment';

          await cleanup();
          const prompt = await sendMessage(chatId, '💬 Введите комментарий (что сделали):', {
            reply_to_message_id: state.originalMessageId
          });
          userStates[chatId].serviceMessages = [prompt];
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_comment' && msg.text) {
          const comment = msg.text.trim();
          const payload = {
            action: 'updateAfterCompletion',
            row: state.row,
            photoUrl: state.photoUrl,
            sum: state.sum,
            comment,
            executor: state.executor,
            message_id: state.originalMessageId
          };

          const result = await axios.post(GAS_WEB_APP_URL, payload);
          const { delay, branch, problem } = result.data?.result || {};

          const text = `📌 Заявка #${state.row} закрыта.
📎 Фото: <a href="${state.photoUrl}">ссылка</a>
💰 Сумма: ${state.sum} сум
👤 Исполнитель: ${state.executor}
✅ Статус: Выполнено
Просрочка: ${delay ?? '—'} дн.`;

          await editMessageText(chatId, state.originalMessageId, text);

          await cleanup();
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
