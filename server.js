const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { createButtonsForStatus, deleteMessages, editOriginalMessage } = require('./messageUtils');

const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwlJy3XL7EF7rcou2fe7O4uC2cVlmeYfM87D-M6ji4KyU0Ds0sp_SiOuT643vIhCwps/exec';

const userStates = {}; // Храним состояние: { [chatId]: { step, row, message_id, ... } }

app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    if (body.callback_query) {
      const callback = body.callback_query;
      const data = callback.data;
      const chatId = callback.message.chat.id;
      const messageId = callback.message.message_id;
      const username = callback.from.username || '';
      const fullMessage = callback.message.text;

      const rowMatch = fullMessage.match(/Заявка №(\d+)/);
      const row = rowMatch ? rowMatch[1] : null;

      if (data === 'in_progress') {
        const newText = `${fullMessage}\n\n🟢 В работе\n👷 Исполнитель: @${username}`;
        const buttons = createButtonsForStatus(row);
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: newText,
          reply_markup: { inline_keyboard: buttons }
        });

        await axios.post(GAS_URL, {
          status: 'В работе',
          row,
          username
        });
        return res.sendStatus(200);
      }

      if (data === 'completed') {
        userStates[chatId] = {
          step: 'waiting_photo',
          row,
          message_id: messageId,
          username
        };
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Пожалуйста, отправьте фото выполненной работы.'
        });
        return res.sendStatus(200);
      }

      if (data === 'delayed') {
        await axios.post(GAS_URL, {
          status: 'Ожидает поставки',
          row,
          username
        });
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Заявка №${row} переведена в статус "Ожидает поставки".`
        });
        return res.sendStatus(200);
      }

      if (data === 'cancelled') {
        await axios.post(GAS_URL, {
          status: 'Отменено',
          row,
          username
        });
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Заявка №${row} отменена.`
        });
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // === Фото ===
    if (body.message && body.message.photo) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId];

      if (state?.step === 'waiting_photo') {
        const photoArray = body.message.photo;
        const fileId = photoArray[photoArray.length - 1].file_id;

        const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileInfo.data.result.file_path;

        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
        const fileExt = path.extname(filePath);
        const localFilePath = path.join(__dirname, `photo_${Date.now()}${fileExt}`);

        const photoStream = await axios.get(fileUrl, { responseType: 'stream' });
        const writer = fs.createWriteStream(localFilePath);
        photoStream.data.pipe(writer);

        await new Promise(resolve => writer.on('finish', resolve));

        const formData = new FormData();
        formData.append('photo', fs.createReadStream(localFilePath));
        formData.append('row', state.row);
        formData.append('username', state.username);
        formData.append('message_id', state.message_id);

        const uploadResponse = await axios.post(GAS_URL, formData, {
          headers: formData.getHeaders()
        });

        fs.unlinkSync(localFilePath);

        userStates[chatId].step = 'waiting_sum';
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Теперь введите сумму выполненных работ (только число):'
        });
        return res.sendStatus(200);
      }
    }

    // === Сумма и Комментарий ===
    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      const state = userStates[chatId];

      if (state?.step === 'waiting_sum') {
        userStates[chatId].sum = text;
        userStates[chatId].step = 'waiting_comment';
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Добавьте комментарий (или "-" если без комментария):'
        });
        return res.sendStatus(200);
      }

      if (state?.step === 'waiting_comment') {
        userStates[chatId].comment = text;
        const payload = {
          row: state.row,
          username: state.username,
          sum: state.sum,
          comment: state.comment,
          message_id: state.message_id
        };
        await axios.post(GAS_URL, payload);

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Заявка №${state.row} закрыта. 💰 Сумма: ${state.sum} сум 👤 Исполнитель: @${state.username}`
        });

        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка:', err.message);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log('Сервер запущен на порту 3000');
});
