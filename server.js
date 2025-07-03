// index.js
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { downloadTelegramFile, deleteMessages } = require('./messageUtils');
const { uploadToDrive, generatePublicUrl } = require('./driveUploader');

const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwlJy3XL7EF7rcou2fe7O4uC2cVlmeYfM87D-M6ji4KyU0Ds0sp_SiOuT643vIhCwps/exec';

const userStates = {};

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const callback = body.callback_query;
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    const username = callback.from.username || '';
    const row = callback.message.text.match(/№(\d+)/)?.[1] || '';

    if (data === 'work') {
      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Выполнено ✅', callback_data: 'done' },
              { text: 'Ожидает поставки 📦', callback_data: 'wait' },
              { text: 'Отмена ❌', callback_data: 'cancel' }
            ]
          ]
        }
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `🟢 Заявка №${row} принята в работу\n👷 Исполнитель: @${username}`,
        reply_to_message_id: messageId
      });

      await axios.post(GAS_URL, {
        row,
        status: 'В работе',
        executor: `@${username}`,
        message_id: messageId
      });

    } else if (data === 'done') {
      userStates[chatId] = { step: 'awaiting_photo', row, messageId, username };
      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: '📷 Пожалуйста, отправьте фото выполненных работ'
      });
      userStates[chatId].serviceMessages = [sent.data.result.message_id];
    }

    return res.sendStatus(200);
  }

  if (body.message) {
    const msg = body.message;
    const chatId = msg.chat.id;

    if (userStates[chatId]) {
      const state = userStates[chatId];

      // 1. Фото
      if (state.step === 'awaiting_photo' && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const filePathRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = filePathRes.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
        const localPath = await downloadTelegramFile(fileUrl, filePath);

        const driveId = await uploadToDrive(localPath);
        const publicUrl = await generatePublicUrl(driveId);
        fs.unlinkSync(localPath);

        state.photoUrl = publicUrl;
        state.step = 'awaiting_sum';

        const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '💰 Введите сумму работ в сумах (только цифры)'
        });
        state.serviceMessages.push(sent.data.result.message_id);
        return res.sendStatus(200);
      }

      // 2. Сумма
      if (state.step === 'awaiting_sum' && msg.text && /^\d+$/.test(msg.text)) {
        state.sum = msg.text;
        state.step = 'awaiting_comment';

        const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '📝 Напишите краткий комментарий по выполненной заявке'
        });
        state.serviceMessages.push(sent.data.result.message_id);
        return res.sendStatus(200);
      }

      // 3. Комментарий
      if (state.step === 'awaiting_comment' && msg.text) {
        state.comment = msg.text;

        const now = new Date();
        const dateString = now.toLocaleDateString('ru-RU');

        // Отправка на GAS
        await axios.post(GAS_URL, {
          row: state.row,
          photo: state.photoUrl,
          sum: state.sum,
          comment: state.comment,
          username: `@${state.username}`,
          message_id: state.messageId,
          closed: dateString
        });

        // Получение просрочки
        const delayRes = await axios.post(GAS_URL, {
          row: state.row,
          action: 'get_delay'
        });
        const delay = delayRes.data.delay || '0';

        // Обновление материнского сообщения
        const msgText = `
📌 Заявка №${state.row} закрыта.
📎 Фото: ${state.photoUrl}
💰 Сумма: ${state.sum} сум
👤 Исполнитель: @${state.username}
✅ Статус: Выполнено
🔴 Просрочка: ${delay} дн.
        `.trim();

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: state.messageId,
          text: msgText
        });

        // Финальное сообщение
        const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Заявка №${state.row} закрыта. Все данные сохранены.`
        });

        state.serviceMessages.push(msg.message_id, sent.data.result.message_id);

        // Удаление через 60 сек
        setTimeout(() => {
          deleteMessages(chatId, state.serviceMessages);
        }, 60000);

        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log('Telegram bot server running on port 3000');
});

