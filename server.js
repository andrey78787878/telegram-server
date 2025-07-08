require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = "https://api.telegram.org/bot" + BOT_TOKEN;
const TELEGRAM_FILE_API = "https://api.telegram.org/file/bot" + BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const PORT = process.env.PORT || 3000;

const userStates = {};

const auth = new google.auth.GoogleAuth({
  keyFile: '/etc/secrets/credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const driveService = google.drive({ version: 'v3', auth });

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

const buildFollowUpButtons = row => ({
  inline_keyboard: [[
    { text: 'Выполнено ✅', callback_data: `completed:${row}` },
    { text: 'Ожидает поставки ⏳', callback_data: `delayed:${row}` },
    { text: 'Отмена ❌', callback_data: `cancelled:${row}` },
  ]]
});

const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];
const buildExecutorButtons = row => ({
  inline_keyboard: EXECUTORS.map(ex => [
    { text: ex, callback_data: `select_executor:${row}:${ex}` }
  ])
});

async function sendMessage(chatId, text, options = {}) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML', ...options });
    return res.data.result.message_id;
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

async function askForPhoto(chatId) {
  const msgId = await sendMessage(chatId, '📸 Пожалуйста, пришлите фото выполненных работ.');
  if (!userStates[chatId]) userStates[chatId] = {};
  if (!userStates[chatId].serviceMessages) userStates[chatId].serviceMessages = [];
  userStates[chatId].serviceMessages.push(msgId);
}
async function askForSum(chatId) {
  const msgId = await sendMessage(chatId, '💰 Введите сумму работ в сумах (только цифры).');
  if (!userStates[chatId]) userStates[chatId] = {};
  if (!userStates[chatId].serviceMessages) userStates[chatId].serviceMessages = [];
  userStates[chatId].serviceMessages.push(msgId);
}
async function askForComment(chatId) {
  const msgId = await sendMessage(chatId, '💬 Добавьте комментарий к заявке.');
  if (!userStates[chatId]) userStates[chatId] = {};
  if (!userStates[chatId].serviceMessages) userStates[chatId].serviceMessages = [];
  userStates[chatId].serviceMessages.push(msgId);
}

app.post('/callback', async (req, res) => {
  console.log('📥 Webhook получен:', JSON.stringify(req.body, null, 2));
  try {
    const body = req.body;

    if (body.callback_query) {
      const { data: raw, message, from } = body.callback_query;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const username = '@' + (from.username || from.first_name);

      const parts = raw.split(':');
      const action = parts[0];
      const row = parts[1] ? parseInt(parts[1], 10) : null;
      const executor = parts[2] || null;

      if (action === 'in_progress' && row) {
        await editMessageText(chatId, messageId,
          `Выберите исполнителя для заявки #${row}:`, buildExecutorButtons(row)
        );
        return res.sendStatus(200);
      }

      if (action === 'select_executor' && row && executor) {
        if (executor === 'Текстовой подрядчик') {
          userStates[chatId] = { stage: 'awaiting_executor_name', row, messageId, originalText: message.text };
          await sendMessage(chatId, 'Введите имя подрядчика вручную:');
          return res.sendStatus(200);
        }

        await axios.post(GAS_WEB_APP_URL, { data: { action: 'markInProgress', row, executor } });
        const newText = `${message.text}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
        await editMessageText(chatId, messageId, newText, buildFollowUpButtons(row));
        await sendMessage(chatId, `✅ Заявка #${row} принята в работу исполнителем ${executor}`, { reply_to_message_id: messageId });
        return res.sendStatus(200);
      }

      if (action === 'completed' && row) {
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username, serviceMessages: [], originalText: message.text };
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

    if (body.message) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId]; if (!state) return res.sendStatus(200);
      const text = body.message.text;
      const userMessageId = body.message.message_id;

      state.lastUserMessageId = userMessageId;

      if (state.stage === 'awaiting_executor_name') {
        const executor = text.trim();
        await axios.post(GAS_WEB_APP_URL, { data: { action: 'markInProgress', row: state.row, executor } });
        const newText = `${state.originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
        await editMessageText(chatId, state.messageId, newText, buildFollowUpButtons(state.row));
        await sendMessage(chatId, `✅ Заявка #${state.row} принята в работу исполнителем ${executor}`, { reply_to_message_id: state.messageId });
        delete userStates[chatId];
        return res.sendStatus(200);
      }

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

      if (state.stage === 'awaiting_sum' && text) {
        if (!/^\d+$/.test(text.trim())) {
          await sendMessage(chatId, '❗ Введите сумму только цифрами.');
          return res.sendStatus(200);
        }

        state.sum = text.trim();
        state.stage = 'awaiting_comment';
        await sendMessage(chatId, '✏️ Введите комментарий к выполненной заявке:');
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_comment' && text) {
        const comment = text.trim();
        const { row, photo, sum, username, messageId, serviceMessages, originalText } = state;

        await axios.post(GAS_WEB_APP_URL, { data: { action: 'updateAfterCompletion', row, photoUrl: photo, sum, comment, executor: username, message_id: messageId } });

        const textForParse = originalText || '';
        const номерПиццерии = (textForParse.match(/🏪 Пиццерия №: (.+)/) || [])[1] || '—';
        const сутьПроблемы = (textForParse.match(/🛠 Проблема:([\s\S]*?)\n/) || [])[1]?.trim() || '—';
        const просрочка = (textForParse.match(/📬 Предельный срок: (.+)/) || [])[1] || '—';

        const updatedText =
          `${textForParse}\n\n✅ Заявка закрыта.\n💬 Комментарий: ${comment}\n📎 Фото: <a href="${photo}">ссылка</a>\n💰 Сумма: ${sum} сум\n✅ Статус: Выполнено`;

        await sendMessage(chatId, `📌 Заявка №${row} закрыта.`, { reply_to_message_id: messageId });
        await editMessageText(chatId, messageId, updatedText, { inline_keyboard: [] });

        setTimeout(async () => {
          try {
            for (const msgId of serviceMessages) {
              await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: msgId }).catch(() => {});
            }
            if (state.lastUserMessageId) {
              await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: state.lastUserMessageId }).catch(() => {});
            }
          } catch (err) {
            console.error('Ошибка удаления сообщений:', err.message);
          }
        }, 60000);

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
