const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwlJy3XL7EF7rcou2fe7O4uC2cVlmeYfM87D-M6ji4KyU0Ds0sp_SiOuT643vIhCwps/exec';

const state = {}; // для отслеживания этапов "Выполнено"

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.callback_query) {
    const cb = body.callback_query;
    const chat_id = cb.message.chat.id;
    const message_id = cb.message.message_id;
    const from = cb.from;
    const username = from.username ? '@' + from.username : from.first_name;
    const data = cb.data;

    if (data === 'accept') {
      // ответ на кнопку "Принято в работу"
      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id,
        message_id,
        reply_markup: {
          inline_keyboard: [[{ text: 'В работе 🟢', callback_data: 'working' }]],
        },
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Заявка принята в работу исполнителем ${username}`,
        reply_to_message_id: message_id,
      });

      await axios.post(GAS_URL, {
        status: 'В работе',
        executor: username,
        message_id,
      });
    }

    if (data === 'working') {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Что сделать с заявкой?`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Выполнено', callback_data: 'done' }],
            [{ text: '🚚 Ожидает поставки', callback_data: 'waiting' }],
            [{ text: '❌ Отмена', callback_data: 'cancel' }],
          ],
        },
        reply_to_message_id: message_id,
      });
    }

    if (data === 'done') {
      // инициируем сбор данных
      state[chat_id] = { step: 'photo', message_id, executor: username };
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: 'Пожалуйста, отправьте фото выполненных работ 📷',
      });
    }

    if (data === 'waiting' || data === 'cancel') {
      const newStatus = data === 'waiting' ? 'Ожидает поставки' : 'Отменено';
      await axios.post(GAS_URL, {
        status: newStatus,
        executor: username,
        message_id,
      });
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Заявка обновлена: ${newStatus}`,
        reply_to_message_id: message_id,
      });
    }

    return res.sendStatus(200);
  }

  if (body.message && state[body.message.chat.id]) {
    const chat_id = body.message.chat.id;
    const userState = state[chat_id];
    const message_id = userState.message_id;

    if (body.message.photo && userState.step === 'photo') {
      const fileId = body.message.photo.pop().file_id;
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      const fileName = `photo_${Date.now()}.jpg`;

      const photoRes = await axios({
        url: fileUrl,
        method: 'GET',
        responseType: 'stream',
      });

      const destPath = path.join(__dirname, fileName);
      const writer = fs.createWriteStream(destPath);
      photoRes.data.pipe(writer);
      await new Promise((resolve) => writer.on('finish', resolve));

      const form = new FormData();
      form.append('file', fs.createReadStream(destPath));
      form.append('filename', fileName);
      form.append('message_id', message_id);
      form.append('executor', userState.executor);
      form.append('username', userState.executor);

      const uploadRes = await axios.post(GAS_URL, form, {
        headers: form.getHeaders(),
      });

      fs.unlinkSync(destPath);
      userState.step = 'sum';
      userState.photoUrl = uploadRes.data.url;

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: 'Введите сумму работ в сумах 💰',
      });
    } else if (userState.step === 'sum' && body.message.text) {
      userState.sum = body.message.text;
      userState.step = 'comment';
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: 'Добавьте комментарий по выполненным работам 📝',
      });
    } else if (userState.step === 'comment' && body.message.text) {
      userState.comment = body.message.text;
      userState.step = 'done';

      await axios.post(GAS_URL, {
        message_id: userState.message_id,
        photoUrl: userState.photoUrl,
        sum: userState.sum,
        comment: userState.comment,
        executor: userState.executor,
        status: 'Выполнено',
      });

      const finalText = `📌 Заявка закрыта.\n📎 Фото: [ссылка](${userState.photoUrl})\n💰 Сумма: ${userState.sum} сум\n👤 Исполнитель: ${userState.executor}\n✅ Статус: Выполнено`;

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: finalText,
        parse_mode: 'Markdown',
        reply_to_message_id: userState.message_id,
      });

      delete state[chat_id];
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log('Telegram bot listening on port 3000');
});
