require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const userStages = {}; // Храним стадии пользователей
const tempMessages = {}; // Храним id сообщений для удаления

// 🔁 Удаление сообщений
const scheduleMessageDeletion = (chatId, messageIds, delayMs = 120000) => {
  setTimeout(async () => {
    for (const msgId of messageIds) {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId,
      }).catch(() => null);
    }
  }, delayMs);
};

// 🔁 Заменить ссылку в родительской заявке через 2 минуты
const updateParentPhotoLink = (row, chatId, messageId) => {
  setTimeout(async () => {
    try {
      await axios.post(GAS_WEB_APP_URL, {
        action: 'getPhotoLinkFromColumnS',
        row,
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (err) {
      console.error('Ошибка при обновлении ссылки из столбца S:', err.message);
    }
  }, 120000);
};

// 🔁 Хэндлер входящих сообщений
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const message = body.message || body.edited_message;
    const callback = body.callback_query;

    // === Кнопки ===
    if (callback) {
      const data = callback.data;
      const chatId = callback.message.chat.id;
      const messageId = callback.message.message_id;
      const username = callback.from.username || callback.from.first_name;
      const row = data.split(':')[1];

      if (data.startsWith('done')) {
        userStages[chatId] = { stage: 'awaiting_photo', row, username, parentMessageId: messageId };
        const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Пожалуйста, отправьте фото выполненной работы 📸',
        });
        tempMessages[chatId] = [msg.data.result.message_id];
        return res.sendStatus(200);
      }
    }

    // === Фото ===
    if (message?.photo && userStages[message.chat.id]?.stage === 'awaiting_photo') {
      const chatId = message.chat.id;
      const { row, username, parentMessageId } = userStages[chatId];

      const fileId = message.photo[message.photo.length - 1].file_id;
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;

      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
      const photoBuffer = await axios.get(fileUrl, { responseType: 'arraybuffer' });

      fs.writeFileSync('./photo.jpg', photoBuffer.data);

      const form = new FormData();
      form.append('photo', fs.createReadStream('./photo.jpg'));
      form.append('row', row);
      form.append('username', username);
      form.append('message_id', parentMessageId);
      form.append('action', 'uploadPhoto');

      await axios.post(GAS_WEB_APP_URL, form, {
        headers: form.getHeaders(),
      });

      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: 'Введите сумму выполненных работ 💰',
      });

      userStages[chatId] = {
        ...userStages[chatId],
        stage: 'awaiting_sum',
        photoMessageId: message.message_id,
      };

      tempMessages[chatId].push(message.message_id, msg.data.result.message_id);
      fs.unlinkSync('./photo.jpg');
      return res.sendStatus(200);
    }

    // === Сумма ===
    if (message?.text && userStages[message.chat.id]?.stage === 'awaiting_sum') {
      const chatId = message.chat.id;
      const sum = message.text;
      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: 'Добавьте комментарий 📝',
      });

      userStages[chatId] = {
        ...userStages[chatId],
        stage: 'awaiting_comment',
        sum,
        sumMessageId: message.message_id,
      };
      tempMessages[chatId].push(message.message_id, msg.data.result.message_id);
      return res.sendStatus(200);
    }

    // === Комментарий ===
    if (message?.text && userStages[message.chat.id]?.stage === 'awaiting_comment') {
      const chatId = message.chat.id;
      const { row, username, sum, parentMessageId } = userStages[chatId];
      const comment = message.text;

      await axios.post(GAS_WEB_APP_URL, {
        action: 'closeRequest',
        row,
        username,
        sum,
        comment,
        message_id: parentMessageId,
      });

      const finalMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `✅ Заявка #${row} закрыта. Спасибо!`,
      });

      tempMessages[chatId].push(message.message_id, finalMsg.data.result.message_id);

      // 🔁 Через 2 минуты:
      updateParentPhotoLink(row, chatId, parentMessageId);
      scheduleMessageDeletion(chatId, tempMessages[chatId]);

      delete userStages[chatId];
      delete tempMessages[chatId];
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка обработки webhook:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
