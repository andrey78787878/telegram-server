require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

const FOLDER_ID = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';

// Google Drive API setup
const KEYFILEPATH = './credentials.json'; // Путь к твоему JSON-файлу с сервисным аккаунтом
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ keyFile: KEYFILEPATH, scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

// Исполнители для выбора
const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

// Хранение промежуточных состояний пользователей
const userStates = {};

// --- Функция загрузки файла с URL в Google Диск ---
async function uploadFileToDrive(fileUrl, filename) {
  try {
    const response = await axios({ method: 'GET', url: fileUrl, responseType: 'stream' });
    const fileMetadata = { name: filename, parents: [FOLDER_ID] };
    const media = { mimeType: response.headers['content-type'], body: response.data };

    const file = await drive.files.create({ resource: fileMetadata, media, fields: 'id' });
    const fileId = file.data.id;

    // Открыть доступ на просмотр всем по ссылке
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });

    // Получить публичную ссылку
    const result = await drive.files.get({ fileId, fields: 'webViewLink, webContentLink' });
    return result.data.webViewLink || result.data.webContentLink;
  } catch (error) {
    console.error('[Google Drive Upload Error]:', error.message);
    return null;
  }
}

// --- Telegram API wrapper ---

async function sendMessage(chatId, text, options = {}) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options,
    });
    return res.data.result.message_id;
  } catch (err) {
    console.error('[sendMessage Error]:', err.response?.data || err.message);
    return null;
  }
}

async function editMessageText(chatId, messageId, text, reply_markup) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup,
    });
  } catch (err) {
    console.error('[editMessageText Error]:', err.response?.data || err.message);
  }
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: messageId });
  } catch (err) {
    console.warn(`[deleteMessage Warning]: Не удалось удалить сообщение ${messageId} в чате ${chatId}`, err.response?.data || err.message);
  }
}

// --- Запросы для фото, суммы, комментария ---

async function askForPhoto(chatId) {
  const messageId = await sendMessage(chatId, "📸 Пожалуйста, пришлите фото выполненных работ.");
  if (messageId && userStates[chatId]) userStates[chatId].messagesToDelete.push(messageId);
}

async function askForSum(chatId) {
  const messageId = await sendMessage(chatId, "💰 Введите сумму работ в сумах (только цифры).");
  if (messageId && userStates[chatId]) userStates[chatId].messagesToDelete.push(messageId);
}

async function askForComment(chatId) {
  const messageId = await sendMessage(chatId, "💬 Добавьте комментарий к заявке.");
  if (messageId && userStates[chatId]) userStates[chatId].messagesToDelete.push(messageId);
}

// --- Удаление сервисных сообщений через 60 секунд ---
function scheduleDeleteMessages(chatId) {
  const messages = userStates[chatId]?.messagesToDelete || [];
  if (messages.length === 0) return;

  setTimeout(() => {
    messages.forEach(msgId => deleteMessage(chatId, msgId));
  }, 60000);
}

// --- Кнопки после принятия заявки ---
function buildFollowUpButtons(row) {
  return {
    inline_keyboard: [
      [
        { text: "Выполнено ✅", callback_data: JSON.stringify({ action: "completed", row }) },
        { text: "Ожидает поставки ⏳", callback_data: JSON.stringify({ action: "delayed", row }) },
        { text: "Отмена ❌", callback_data: JSON.stringify({ action: "cancelled", row }) }
      ]
    ]
  };
}

// --- Кнопки выбора исполнителя ---
function buildExecutorButtons(row) {
  return {
    inline_keyboard: EXECUTORS.map(executor => ([{
      text: executor,
      callback_data: JSON.stringify({ action: 'select_executor', row, executor })
    }]))
  };
}

// --- Основной webhook ---

app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    // --- Обработка callback_query ---
    if (body.callback_query) {
      console.log('[callback_query received]:', body.callback_query.data);

      const dataRaw = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + (body.callback_query.from.username || body.callback_query.from.first_name);

      let data;
      try {
        data = JSON.parse(dataRaw);
      } catch (e) {
        console.warn('[callback_data parse error]:', dataRaw);
        return res.sendStatus(200);
      }

      const { action, row, executor } = data;

      if (action === 'in_progress' && row) {
        // Запрашиваем выбор исполнителя
        await editMessageText(chatId, messageId, `Выберите исполнителя для заявки #${row}:`, buildExecutorButtons(row));
        return res.sendStatus(200);
      }

      if (action === 'select_executor' && row && executor) {
        // Отправляем в GAS статус "В работе" и исполнителя
        await axios.post(GAS_WEB_APP_URL, {
          data: { action: 'markInProgress', row, executor }
        });

        // Обновляем материнское сообщение с исполнителем и кнопками дальше
        await editMessageText(chatId, messageId,
          `🟢 Заявка #${row} в работе.\n👤 Исполнитель: ${executor}`,
          buildFollowUpButtons(row)
        );

        await sendMessage(chatId, `✅ Заявка #${row} принята в работу исполнителем ${executor}`, { reply_to_message_id: messageId });

        return res.sendStatus(200);
      }

      if (action === 'completed' && row) {
        // Запускаем сбор данных по заявке
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username, messagesToDelete: [] };
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      if ((action === 'delayed' || action === 'cancelled') && row) {
        await axios.post(GAS_WEB_APP_URL, { data: { action, row, executor: username } });

        await editMessageText(chatId, messageId,
          `📌 Заявка #${row}\n⚠️ Статус: ${action === 'delayed' ? 'Ожидает поставки' : 'Отменена'}\n👤 Исполнитель: ${username}`
        );
        return res.sendStatus(200);
      }
    }
    // --- Обработка сообщений от пользователя (текст, фото) ---
    else if (body.message) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId];
      if (!state) return res.sendStatus(200);

      // Фото
      if (state.stage === 'awaiting_photo' && body.message.photo) {
        const fileId = body.message.photo.at(-1).file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        const telegramFileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

        const googleDriveUrl = await uploadFileToDrive(telegramFileUrl, `photo_${Date.now()}.jpg`);
        if (!googleDriveUrl) {
          const msgId = await sendMessage(chatId, "❌ Ошибка загрузки фото на Google Диск. Попробуйте еще раз.");
          if (msgId) state.messagesToDelete.push(msgId);
          return res.sendStatus(200);
        }

        state.photo = googleDriveUrl;
        state.stage = 'awaiting_sum';

        await askForSum(chatId);
        return res.sendStatus(200);
      }

      // Сумма
      if (state.stage === 'awaiting_sum' && body.message.text) {
        const sum = body.message.text.trim();
        if (!/^\d+$/.test(sum)) {
          const msgId = await sendMessage(chatId, "❗ Введите сумму только цифрами, без пробелов и символов.");
          if (msgId) state.messagesToDelete.push(msgId);
          return res.sendStatus(200);
        }

        state.sum = sum;
        state.stage = 'awaiting_comment';

        await askForComment(chatId);
        return res.sendStatus(200);
      }

      // Комментарий
      if (state.stage === 'awaiting_comment' && body.message.text) {
        const comment = body.message.text.trim();
        const { row, photo, sum, username, messageId, messagesToDelete } = state;

        // Отправляем в GAS для обновления таблицы и закрытия заявки
        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'updateAfterCompletion',
            row,
            photoUrl: photo,
            sum,
            comment,
            executor: username,
            message_id: messageId
          }
        });

        // Итоговое сообщение
        const finalMsgId = await sendMessage(
          chatId,
          `📌 Заявка #${row} закрыта.\n📎 Фото: <a href="${photo}">ссылка</a>\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${username}\n✅ Статус: Выполнено\n⏰ Просрочка: (данные из таблицы)`,
          { parse_mode: 'HTML' }
        );

        if (finalMsgId) messagesToDelete.push(finalMsgId);

        // Запускаем удаление сервисных сообщений через 60 секунд
        scheduleDeleteMessages(chatId);

        // Очистка состояния
        delete userStates[chatId];

        return res.sendStatus(200);
      }
    }

    // Если ни того ни другого — ответить 200
    return res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook Error]:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
