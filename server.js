app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    // === 1. Обработка нажатий на кнопки (callback_query)
    if (body.callback_query) {
      console.log('➡️ Получен callback_query:', body.callback_query);

      const dataRaw = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + (body.callback_query.from.username || body.callback_query.from.first_name);

      // --- Если кнопка: выбор исполнителя
      if (dataRaw.startsWith('select_executor:')) {
        const parts = dataRaw.split(':');
        const row = parts[1];
        const executor = parts[2];

        if (!row || !executor) {
          console.warn("⚠️ Неверный формат select_executor:", dataRaw);
          return res.sendStatus(200);
        }

        console.log(`👤 Выбран исполнитель ${executor} для заявки #${row}`);

        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'markInProgress',
            row,
            executor
          }
        });

        await editMessageText(
          chatId,
          messageId,
          `🟢 Заявка #${row} в работе.\n👤 Исполнитель: ${executor}`,
          buildFollowUpButtons(row)
        );

        return res.sendStatus(200);
      }

      // --- Все остальные кнопки (выполнено, отмена, задержка)
      let data;
      try {
        data = JSON.parse(dataRaw);
      } catch (e) {
        console.warn("⚠️ Невалидный JSON в callback_data:", dataRaw);
        return res.sendStatus(200);
      }

      const { action, row, messageId: originalMessageId } = data;

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
        console.log(`📸 Ожидается фото от ${username} для заявки #${row}`);
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

    // === 2. Обработка обычных сообщений (фото, сумма, комментарий)
    else if (body.message) {
      console.log('✉️ Получено сообщение:', body.message);

      const chatId = body.message.chat.id;
      const state = userStates[chatId];
      if (!state) return res.sendStatus(200);

      // --- Фото
      if (state.stage === 'awaiting_photo' && body.message.photo) {
        const fileId = body.message.photo.at(-1).file_id;

        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

        state.photo = fileUrl;
        state.stage = 'awaiting_sum';

        console.log(`📥 Фото получено. URL: ${fileUrl}`);
        await askForSum(chatId);
        return res.sendStatus(200);
      }

      // --- Сумма
      if (state.stage === 'awaiting_sum' && body.message.text) {
        const sum = body.message.text.trim();
        if (!/^\d+$/.test(sum)) {
          await sendMessage(chatId, "❗ Введите сумму только цифрами.");
          return res.sendStatus(200);
        }

        state.sum = sum;
        state.stage = 'awaiting_comment';

        console.log(`💰 Сумма получена: ${sum}`);
        await askForComment(chatId);
        return res.sendStatus(200);
      }

      // --- Комментарий
      if (state.stage === 'awaiting_comment' && body.message.text) {
        const comment = body.message.text.trim();
        const { row, photo, sum, username, messageId } = state;

        console.log('📤 Отправка в GAS:', {
          action: 'updateAfterCompletion',
          row,
          photoUrl: photo,
          sum,
          comment,
          executor: username,
          message_id: messageId
        });

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

    // === Если ничего не подошло — ответим Telegram, чтобы не ругался
    console.log('⚠️ Ничего не обработано явно. Возврат 200 OK');
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка в webhook:", err);
    return res.sendStatus(500);
  }
});

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const CHAT_ID = -1002582747660;

const userState = {};
const messageMap = {};

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'credentials.json'),
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

async function downloadFile(fileId) {
  const fileUrlResp = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileUrlResp.data.result.file_path;
  const downloadUrl = `${TELEGRAM_FILE_API}/${filePath}`;
  const response = await axios.get(downloadUrl, { responseType: 'stream' });

  const tempPath = path.join(__dirname, 'temp', `${fileId}.jpg`);
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return tempPath;
}

async function uploadToDrive(filePath) {
  const fileName = path.basename(filePath);
  const fileMetadata = {
    name: fileName,
    parents: [GOOGLE_DRIVE_FOLDER_ID],
  };
  const media = {
    mimeType: 'image/jpeg',
    body: fs.createReadStream(filePath),
  };

  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id',
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  fs.unlinkSync(filePath);
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

async function sendTelegramMessage(chat_id, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

async function deleteMessage(chat_id, message_id, delay = 60000) {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id,
      message_id,
    }).catch(() => {});
  }, delay);
}

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { message, data, from } = body.callback_query;
    const message_id = message.message_id;
    const username = from.username || from.first_name || 'неизвестно';

    const row = parseInt(data.split(':')[1]);
    const action = data.split(':')[0];

    if (action === 'start') {
      userState[from.id] = { step: 'awaiting_photo', row, username, message_id };
      await sendTelegramMessage(from.id, '📷 Пришлите фото выполненных работ.');
    }

    if (action === 'accept') {
      await axios.post(GAS_WEB_APP_URL, {
        message_id,
        status: 'В работе',
        executor: `@${username}`,
      });

      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id: message.chat.id,
        message_id: message.message_id,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Выполнено', callback_data: `start:${row}` },
            { text: '🚚 Ожидает поставки', callback_data: `wait:${row}` },
            { text: '❌ Отмена', callback_data: `cancel:${row}` }
          ]]
        }
      });

      await sendTelegramMessage(message.chat.id, `🔧 Заявка №${row} принята в работу @${username}`, {
        reply_to_message_id: message.message_id
      });
    }

    res.sendStatus(200);
    return;
  }

  if (body.message && body.message.photo && userState[body.message.from.id]?.step === 'awaiting_photo') {
    const { row, username, message_id } = userState[body.message.from.id];
    const photoArray = body.message.photo;
    const fileId = photoArray[photoArray.length - 1].file_id;

    try {
      const tempPath = await downloadFile(fileId);
      const driveUrl = await uploadToDrive(tempPath);

      userState[body.message.from.id].step = 'awaiting_sum';
      userState[body.message.from.id].photoUrl = driveUrl;

      const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: body.message.chat.id,
        text: '💰 Введите сумму выполненных работ:',
      });

      messageMap[from.id] = [body.message.message_id, reply.data.result.message_id];
    } catch (e) {
      console.error('Ошибка загрузки фото:', e.message);
    }

    res.sendStatus(200);
    return;
  }

  if (body.message && userState[body.message.from.id]?.step === 'awaiting_sum') {
    const sum = body.message.text;
    userState[body.message.from.id].sum = sum;
    userState[body.message.from.id].step = 'awaiting_comment';

    const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: body.message.chat.id,
      text: '📝 Добавьте комментарий:',
    });

    messageMap[body.message.from.id].push(body.message.message_id, reply.data.result.message_id);

    res.sendStatus(200);
    return;
  }

  if (body.message && userState[body.message.from.id]?.step === 'awaiting_comment') {
    const comment = body.message.text;
    const { row, username, message_id, sum, photoUrl } = userState[body.message.from.id];

    try {
      await axios.post(GAS_WEB_APP_URL, {
        row,
        photo: photoUrl,
        sum,
        comment,
        username,
        message_id
      });

      const result = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: body.message.chat.id,
        text: `✅ Заявка #${row} закрыта. 💰 Сумма: ${sum} сум 👤 Исполнитель: @${username}`,
      });

      // Удаляем промежуточные сообщения
      messageMap[body.message.from.id].forEach(mid => {
        deleteMessage(body.message.chat.id, mid);
      });
      deleteMessage(body.message.chat.id, result.data.result.message_id);

      delete userState[body.message.from.id];
    } catch (e) {
      console.error('Ошибка финальной записи:', e.message);
    }

    res.sendStatus(200);
    return;
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Bot server is running`);
});
