require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const FOLDER_ID = process.env.FOLDER_ID;
const PORT = process.env.PORT || 3000;

const userStates = {}; // userStates: chatId -> { stage, row, messageId, username, photo, sum, comment }

// Google Drive API auth
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const driveService = google.drive({ version: 'v3', auth });

async function uploadToDriveFromUrl(fileUrl, fileName) {
  const tempPath = path.join(__dirname, fileName);
  const response = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
  const writer = fs.createWriteStream(tempPath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const fileMetadata = {
    name: fileName,
    parents: [FOLDER_ID],
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(tempPath),
  };

  const file = await driveService.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
  });

  await driveService.permissions.create({
    fileId: file.data.id,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
  });

  fs.unlinkSync(tempPath);
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

const buildFollowUpButtons = (row) => ({
  inline_keyboard: [
    [
      { text: "Выполнено ✅", callback_data: JSON.stringify({ action: "completed", row }) },
      { text: "Ожидает поставки ⏳", callback_data: JSON.stringify({ action: "delayed", row }) },
      { text: "Отмена ❌", callback_data: JSON.stringify({ action: "cancelled", row }) }
    ]
  ]
});

async function sendMessage(chatId, text, options = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
  } catch (err) {
    console.error("Ошибка отправки сообщения:", err.response?.data || err.message);
  }
}

async function editMessageText(chatId, messageId, text, reply_markup) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup
    });
  } catch (err) {
    console.error("Ошибка редактирования сообщения:", err.response?.data || err.message);
  }
}

async function askForPhoto(chatId) {
  await sendMessage(chatId, "📸 Пожалуйста, пришлите фото выполненных работ.");
}

async function askForSum(chatId) {
  await sendMessage(chatId, "💰 Введите сумму работ в сумах (только цифры).");
}

async function askForComment(chatId) {
  await sendMessage(chatId, "💬 Добавьте комментарий к заявке.");
}

// !!! Используй /callback если ты поставил Webhook на /callback
app.post('/callback', async (req, res) => {
  const body = req.body;
  console.log("📥 Webhook получен:", JSON.stringify(body, null, 2));

  try {
    if (body.callback_query) {
      const dataRaw = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + (body.callback_query.from.username || body.callback_query.from.first_name);

      let data;
      try {
        data = JSON.parse(dataRaw);
      } catch {
        console.warn("⚠️ Некорректный callback_data:", dataRaw);
        return res.sendStatus(200);
      }

      const { action, row } = data;

      if (action === 'in_progress' && row) {
        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'markInProgress',
            row,
            executor: username
          }
        });

        await editMessageText(
          chatId,
          messageId,
          `🟢 Заявка #${row} в работе.\n👤 Исполнитель: ${username}`,
          buildFollowUpButtons(row)
        );
        return res.sendStatus(200);
      }

      if (action === 'completed' && row) {
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username };
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      if ((action === 'delayed' || action === 'cancelled') && row) {
        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action,
            row,
            executor: username
          }
        });

        await editMessageText(
          chatId,
          messageId,
          `📌 Заявка #${row}\n⚠️ Статус: ${action === 'delayed' ? 'Ожидает поставки' : 'Отменена'}\n👤 Исполнитель: ${username}`
        );
        return res.sendStatus(200);
      }
    }

    else if (body.message) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId];
      if (!state) return res.sendStatus(200);

      if (state.stage === 'awaiting_photo' && body.message.photo) {
        const fileId = body.message.photo.at(-1).file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

        const driveLink = await uploadToDriveFromUrl(fileUrl, `completed_${state.row}_${Date.now()}.jpg`);
        state.photo = driveLink;
        state.stage = 'awaiting_sum';

        await askForSum(chatId);
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_sum' && body.message.text) {
        const sum = body.message.text.trim();
        if (!/^\d+$/.test(sum)) {
          await sendMessage(chatId, "💰 Введите сумму работ в сумах (только цифры).");
          return res.sendStatus(200);
        }

        state.sum = sum;
        state.stage = 'awaiting_comment';
        await askForComment(chatId);
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_comment' && body.message.text) {
        const comment = body.message.text.trim();
        const { row, photo, sum, username, messageId } = state;

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

        await sendMessage(
          chatId,
          `📌 Заявка #${row} закрыта.\n📎 Фото: <a href="${photo}">ссылка</a>\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${username}`
        );

        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка обработки webhook:", err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

