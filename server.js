require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const PORT = process.env.PORT || 3000;

const userStates = {};

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

function buildFollowUpButtons(row) {
  return {
    inline_keyboard: [[
      { text: 'Выполнено ✅', callback_data: `completed:${row}` },
      { text: 'Ожидает поставки ⏳', callback_data: `delayed:${row}` },
      { text: 'Отмена ❌', callback_data: `cancelled:${row}` },
    ]]
  };
}

const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];
function buildExecutorButtons(row) {
  return {
    inline_keyboard: EXECUTORS.map(ex => [
      { text: ex, callback_data: `select_executor:${row}:${ex}` }
    ])
  };
}

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
  userStates[chatId] ??= { serviceMessages: [] };
  userStates[chatId].serviceMessages.push(msgId);
}

async function askForSum(chatId) {
  const msgId = await sendMessage(chatId, '💰 Введите сумму работ в сумах (только цифры).');
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

      const parts = raw.startsWith('{') ? JSON.parse(raw) : raw.split(':');
      const action = parts.action || parts[0];
      const row = Number(parts.row || parts[1]);
      const executor = parts.executor || parts[2] || null;

      if (action === 'in_progress') {
        userStates[chatId] = { originalText: message.text, row, messageId };
        const keyboard = buildExecutorButtons(row);
        await sendMessage(chatId, `Выберите исполнителя для заявки #${row}:`, {
          reply_to_message_id: messageId,
          reply_markup: keyboard
        });
      }

      if (action === 'select_executor' && executor) {
        if (executor === 'Текстовой подрядчик') {
          userStates[chatId].stage = 'awaiting_executor_name';
          await sendMessage(chatId, 'Введите имя подрядчика вручную:');
          return res.sendStatus(200);
        }

        const originalText = userStates[chatId]?.originalText || message.text;
        const cleanedText = originalText
          .replace(/🟢 Заявка #\d+ в работе\.\n👷 Исполнитель: @\S+\n*/g, '')
          .replace(/✅ Заявка #\d+ закрыта\..*?\n*/gs, '')
          .replace(/🟢 В работе\n👷 Исполнитель:.*(\n)?/g, '')
          .trim();
        const updatedText = `${cleanedText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;

        const keyboard = {
          inline_keyboard: [
            [{ text: `✅ В работе ${executor}`, callback_data: 'noop' }],
            [
              { text: 'Выполнено', callback_data: JSON.stringify({ action: 'done', row, messageId }) },
              { text: 'Ожидает поставки', callback_data: JSON.stringify({ action: 'delayed', row, messageId }) },
              { text: 'Отмена', callback_data: JSON.stringify({ action: 'cancel', row, messageId }) }
            ]
          ]
        };

        await editMessageText(chatId, messageId, updatedText, keyboard);
        const infoMsg = await sendMessage(chatId, `📌 Заявка №${row} принята в работу исполнителем ${executor}`, {
          reply_to_message_id: messageId
        });

        setTimeout(() => {
          axios.post(`${TELEGRAM_API}/deleteMessage`, {
            chat_id: chatId,
            message_id: infoMsg
          }).catch(() => {});
        }, 60000);

        await axios.post(GAS_WEB_APP_URL, {
          action: 'in_progress',
          row,
          message_id: messageId,
          executor
        });

        return res.sendStatus(200);
      }

      if (action === 'done') {
        userStates[chatId] = {
          stage: 'awaiting_photo',
          row,
          messageId,
          username,
          serviceMessages: [],
          originalText: message.text
        };
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      if (action === 'delayed' || action === 'cancelled') {
        await axios.post(GAS_WEB_APP_URL, { data: { action, row, executor: username } });
        const status = action === 'delayed' ? 'Ожидает поставки' : 'Отменена';
        const updated = `${message.text}\n\n📌 Статус: ${status}\n👤 Исполнитель: ${username}`;
        await editMessageText(chatId, messageId, updated);
        return res.sendStatus(200);
      }
    }

    if (body.message) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      const userMessageId = body.message.message_id;
      const state = userStates[chatId];

      if (!state) return res.sendStatus(200);

      state.lastUserMessageId = userMessageId;

      if (state.stage === 'awaiting_executor_name') {
        const executor = text.trim();
        await axios.post(GAS_WEB_APP_URL, { data: { action: 'markInProgress', row: state.row, executor } });
        const updatedText = `${state.originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
        await editMessageText(chatId, state.messageId, updatedText, buildFollowUpButtons(state.row));
        await sendMessage(chatId, `✅ Заявка #${state.row} принята в работу исполнителем ${executor}`, { reply_to_message_id: state.messageId });
        delete userStates[chatId];
        return res.sendStatus(200);
      }

if (state.stage === 'awaiting_photo' && body.message.photo) {
  const fileId = body.message.photo.slice(-1)[0].file_id;
  const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const fileUrl = `${TELEGRAM_FILE_API}/${fileRes.data.result.file_path}`;
  state.photo = fileUrl;  // просто ссылка на фото из Telegram
  state.stage = 'awaiting_sum';
  await askForSum(chatId);
  return res.sendStatus(200);
}


      if (state.stage === 'awaiting_sum') {
        if (!/^\d+$/.test(text.trim())) {
          await sendMessage(chatId, '❗ Введите сумму только цифрами.');
          return res.sendStatus(200);
        }
        state.sum = text.trim();
        state.stage = 'awaiting_comment';
        await sendMessage(chatId, '✏️ Введите комментарий к выполненной заявке:');
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_comment') {
        const comment = text.trim();
        const { row, photo, sum, username, messageId, originalText, serviceMessages } = state;

        await axios.post(GAS_WEB_APP_URL, {
          data: { action: 'updateAfterCompletion', row, photoUrl: photo, sum, comment, executor: username, message_id: messageId }
        });

        const cleanedText = originalText
          .replace(/\n?🟢 В работе.*?(\n👷 Исполнитель:.*)?/, '')
          .replace(/\n?📎 Фото: .*$/m, '')
          .replace(/\n?💰 Сумма: .*$/m, '')
          .replace(/\n?👤 Исполнитель: .*$/m, '')
          .replace(/\n?✅ Статус: .*$/m, '')
          .replace(/\n?⏱ Просрочка: .*$/m, '')
          .replace(/\n?✅ Заявка закрыта\..*$/m, '');

        const updatedText = `${cleanedText}
📎 Фото: <a href="${photo}">ссылка</a>
💰 Сумма: ${sum} сум
👤 Исполнитель: ${username}
✅ Статус: Выполнено
💬 Комментарий: ${comment}`.trim();

        await editMessageText(chatId, messageId, updatedText, { inline_keyboard: [] });
        await sendMessage(chatId, `📌 Заявка №${row} закрыта.`, { reply_to_message_id: messageId });

        setTimeout(() => {
          [...(serviceMessages || []), userMessageId].forEach(msgId => {
            axios.post(`${TELEGRAM_API}/deleteMessage`, {
              chat_id: chatId,
              message_id: msgId
            }).catch(() => {});
          });
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

const { router: authRouter } = require('./auth');
app.use(authRouter);

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
