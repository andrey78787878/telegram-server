require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// ========== УДАЛЕНИЕ СООБЩЕНИЙ ЧЕРЕЗ 2 МИНУТЫ ==========
function scheduleMessageDeletion(chatId, messageId, delayMs = 2 * 60 * 1000) {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    }).catch(err => console.error('Ошибка удаления сообщения:', err?.response?.data));
  }, delayMs);
}

// ========== ЗАГРУЗКА ФОТО И ОТПРАВКА В GAS ==========
async function handlePhotoUpload(chatId, photo, row, messageId, username) {
  const fileId = photo[photo.length - 1].file_id;
  const filePathRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = filePathRes.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const localPath = path.join(tempDir, path.basename(filePath));

  const writer = fs.createWriteStream(localPath);
  const photoStream = await axios.get(fileUrl, { responseType: 'stream' });
  photoStream.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const form = new FormData();
  form.append('photo', fs.createReadStream(localPath));
  form.append('row', row);
  form.append('message_id', messageId);
  form.append('username', username);

  await axios.post(GAS_WEB_APP_URL, form, { headers: form.getHeaders() });

  fs.unlinkSync(localPath);
}

// ========== ОБНОВЛЕНИЕ СТРОКИ "📎 Фото: ..." В МАТЕРИНСКОМ СООБЩЕНИИ ==========
async function updateMotherMessageWithNewPhoto(chatId, messageId, row) {
  try {
    const gasRes = await axios.post(GAS_WEB_APP_URL, {
      action: 'getPhotoLinkFromColumnS',
      row,
    });

    const newPhotoLink = gasRes.data?.photoLink;
    if (!newPhotoLink) return;

    const res = await axios.post(`${TELEGRAM_API}/getChat`, { chat_id: chatId });
    const msgRes = await axios.post(`${TELEGRAM_API}/getMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });

    const originalText = msgRes.data?.result?.text;
    if (!originalText) return;

    const updatedText = originalText.replace(/📎 Фото: .*/, `📎 Фото: ${newPhotoLink}`);

    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text: updatedText,
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.error('Ошибка при обновлении фото-ссылки в сообщении:', err?.response?.data || err.message);
  }
}

// ========== ПРИЁМ ЗАПРОСОВ ОТ TELEGRAM ==========
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.message?.photo) {
      const { chat, photo, message_id, caption } = body.message;
      const row = caption?.match(/row=(\d+)/)?.[1];
      const parentMessageId = caption?.match(/parent=(\d+)/)?.[1];
      const username = body.message.from?.username || '';

      if (row && parentMessageId) {
        await handlePhotoUpload(chat.id, photo, row, parentMessageId, username);

        // Обновить ссылку в материнском сообщении
        await updateMotherMessageWithNewPhoto(chat.id, parentMessageId, row);
      }

      scheduleMessageDeletion(chat.id, message_id);
    }

    if (body.message?.text && body.message?.reply_to_message?.text?.includes('Введите сумму')) {
      const { chat, message_id, text } = body.message;
      scheduleMessageDeletion(chat.id, message_id);
    }

    if (body.message?.text && body.message?.reply_to_message?.text?.includes('Введите комментарий')) {
      const { chat, message_id, text } = body.message;
      scheduleMessageDeletion(chat.id, message_id);
    }

    if (body.message?.text?.includes('Заявка #') && body.message?.text?.includes('закрыта')) {
      const { chat, message_id } = body.message;
      scheduleMessageDeletion(chat.id, message_id);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка в webhook:', err?.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
