require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// ========== Удаление сообщений ==========
function scheduleMessageDeletion(chatId, messageId, delayMs = 2 * 60 * 1000) {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    }).catch(err => console.error('Ошибка удаления сообщения:', err?.response?.data));
  }, delayMs);
}

// ========== Загрузка фото и отправка в GAS ==========
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

// ========== Обновление 📎 Фото: ... в сообщении ==========
async function updateMotherMessageWithNewPhoto(chatId, messageId, row) {
  try {
    const gasRes = await axios.post(GAS_WEB_APP_URL, {
      action: 'getPhotoLinkFromColumnS',
      row,
    });

    const newPhotoLink = gasRes.data?.photoLink;
    if (!newPhotoLink) return;

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
    console.error('Ошибка при обновлении фото-ссылки:', err?.response?.data || err.message);
  }
}

// ========== Webhook ==========
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // === Обработка callback_query ===
  if (body.callback_query) {
    const callback = body.callback_query;
    const data = callback.data;
    const [action, row, executor] = data.split(':');

    if (action === 'select_executor') {
      try {
        // Обновляем в GAS
        await axios.post(GAS_WEB_APP_URL, {
          action: 'in_progress',
          row,
          executor,
        });

        // Удаляем inline-кнопки
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });

        // Уведомляем
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: callback.from.id,
          text: `✅ Заявка #${row} принята в работу исполнителем ${executor}`,
        });

        return res.sendStatus(200);
      } catch (err) {
        console.error('Ошибка обработки кнопки:', err?.response?.data || err.message);
        return res.sendStatus(500);
      }
    }

    return res.sendStatus(200);
  }

  // === Обработка фото ===
  if (body.message?.photo) {
    const { chat, photo, message_id, caption } = body.message;
    const row = caption?.match(/row=(\d+)/)?.[1];
    const parentMessageId = caption?.match(/parent=(\d+)/)?.[1];
    const username = body.message.from?.username || '';

    if (row && parentMessageId) {
      await handlePhotoUpload(chat.id, photo, row, parentMessageId, username);
      await updateMotherMessageWithNewPhoto(chat.id, parentMessageId, row);
    }

    scheduleMessageDeletion(chat.id, message_id);
    return res.sendStatus(200);
  }

  // === Удаление ответов на сумму/комментарий ===
  if (body.message?.text && body.message?.reply_to_message?.text?.includes('Введите сумму')) {
    scheduleMessageDeletion(body.message.chat.id, body.message.message_id);
  }

  if (body.message?.text && body.message?.reply_to_message?.text?.includes('Введите комментарий')) {
    scheduleMessageDeletion(body.message.chat.id, body.message.message_id);
  }

  // === Удаление финальных уведомлений ===
  if (body.message?.text?.includes('Заявка #') && body.message?.text?.includes('закрыта')) {
    scheduleMessageDeletion(body.message.chat.id, body.message.message_id);
  }

  res.sendStatus(200);
});

// === Запуск сервера ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
