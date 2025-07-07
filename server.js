```javascript
require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// Telegram API setup
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

// GAS Web App URL and Drive folder ID
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const PORT = process.env.PORT || 3000;

// In-memory user state for multi-step flows
const userStates = {}; // chatId -> { stage, row, messageId, username, photo, sum, comment }

// Google Drive API auth using service account (credentials.json mounted at /etc/secrets)
const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const driveService = google.drive({ version: 'v3', auth });

// Upload a file from URL to Google Drive and return public link
async function uploadToDriveFromUrl(fileUrl, fileName) {
  const tempPath = path.join(__dirname, fileName);
  const response = await axios.get(fileUrl, { responseType: 'stream' });
  const writer = fs.createWriteStream(tempPath);
  response.data.pipe(writer);
  await new Promise((resolve, reject) => writer.on('finish', resolve).on('error', reject));

  const file = await driveService.files.create({
    requestBody: { name: fileName, parents: [FOLDER_ID] },
    media: { mimeType: 'image/jpeg', body: fs.createReadStream(tempPath) },
    fields: 'id',
  });
  await driveService.permissions.create({ fileId: file.data.id, requestBody: { role: 'reader', type: 'anyone' } });
  fs.unlinkSync(tempPath);
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

// Buttons for follow-up actions
const buildFollowUpButtons = row => ({
  inline_keyboard: [[
    { text: 'Выполнено ✅', callback_data: JSON.stringify({ action: 'completed', row }) },
    { text: 'Ожидает поставки ⏳', callback_data: JSON.stringify({ action: 'delayed', row }) },
    { text: 'Отмена ❌', callback_data: JSON.stringify({ action: 'cancelled', row }) },
  ]]
});

// List of executors and buttons for selection
const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];
const buildExecutorButtons = row => ({
  inline_keyboard: EXECUTORS.map(ex => [
    { text: ex, callback_data: JSON.stringify({ action: 'select_executor', row, executor: ex }) }
  ])
});

// Helpers for Telegram
async function sendMessage(chatId, text, options = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML', ...options });
  } catch (e) {
    console.error('Ошибка отправки:', e.response?.data || e.message);
  }
}
async function editMessageText(chatId, messageId, text, reply_markup) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup });
  } catch (e) {
    console.error('Ошибка редактирования:', e.response?.data || e.message);
  }
}

// Multi-step prompts
const askForPhoto   = chatId => sendMessage(chatId, '📸 Пожалуйста, пришлите фото выполненных работ.');
const askForSum     = chatId => sendMessage(chatId, '💰 Введите сумму работ в сумах (только цифры).');
const askForComment = chatId => sendMessage(chatId, '💬 Добавьте комментарий к заявке.');

// Webhook endpoint (configured at /callback)
app.post('/callback', async (req, res) => {
  console.log('📥 Webhook получен:', JSON.stringify(req.body, null, 2));
  try {
    const body = req.body;

    // Handle button presses
    if (body.callback_query) {
      const { data: raw, message, from } = body.callback_query;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const username = '@' + (from.username || from.first_name);
      let data;
      try { data = JSON.parse(raw); } catch { return res.sendStatus(200); }
      const { action, row, executor } = data;

      // Initial in_progress -> choose executor
      if (action === 'in_progress' && row) {
        await editMessageText(chatId, messageId,
          `Выберите исполнителя для заявки #${row}:`, buildExecutorButtons(row)
        );
        return res.sendStatus(200);
      }
      // Executor selected
      if (action === 'select_executor' && row && executor) {
        // Update status in GAS
        await axios.post(GAS_WEB_APP_URL, { data: { action: 'markInProgress', row, executor } });
        // Append to text and show follow-up
        const newText = `${message.text}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
        await editMessageText(chatId, messageId, newText, buildFollowUpButtons(row));
        await sendMessage(chatId, `✅ Заявка #${row} принята в работу исполнителем ${executor}`, { reply_to_message_id: messageId });
        return res.sendStatus(200);
      }
      // Follow-up actions
      if (action === 'completed' && row) {
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username };
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }
      if ((action === 'delayed' || action === 'cancelled') && row) {
        await axios.post(GAS_WEB_APP_URL, { data: { action, row, executor: username } });
        const status = action === 'delayed' ? 'Ожидает поставки' : 'Отменена';
        const updated = `${message.text}\n\n📌 Статус: ${status}\n👤 Исполнитель: ${username}`;
        await editMessageText(chatId, messageId, updated);
        return res.sendStatus(200);
      }
    }

    // Handle user replies in flows
    if (body.message) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId]; if (!state) return res.sendStatus(200);
      const text = body.message.text;

      // Photo received
      if (state.stage === 'awaiting_photo' && body.message.photo) {
        const fileId = body.message.photo.slice(-1)[0].file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const fileUrl = `${TELEGRAM_FILE_API}/${fileRes.data.result.file_path}`;
        const driveLink = await uploadToDriveFromUrl(fileUrl, `work_${state.row}_${Date.now()}.jpg`);
        state.photo = driveLink;
        state.stage = 'awaiting_sum';
        await askForSum(chatId);
        return res.sendStatus(200);
      }
      // Sum entered
      if (state.stage === 'awaiting_sum' && text) {
        if (!/^\d+$/.test(text.trim())) {
          await sendMessage(chatId, '❗ Введите сумму только цифрами.');
          return res.sendStatus(200);
        }
        state.sum = text.trim();
        state.stage = 'awaiting_comment';
        await askForComment(chatId);
        return res.sendStatus(200);
      }
      // Comment entered
      if (state.stage === 'awaiting_comment' && text) {
        const comment = text.trim();
        const { row, photo, sum, username, messageId } = state;
        await axios.post(GAS_WEB_APP_URL, { data: { action: 'updateAfterCompletion', row, photoUrl: photo, sum, comment, executor: username, message_id: messageId } });
        await sendMessage(chatId, `📌 Заявка #${row} закрыта.\n📎 Фото: <a href="${photo}">ссылка</a>\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${username}`);
        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('❌ Ошибка обработки webhook:', e);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
```
