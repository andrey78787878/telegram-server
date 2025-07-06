require('dotenv').config({ path: './.env' });

const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

const { BOT_TOKEN, TELEGRAM_API } = require('./config');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { downloadTelegramFile, uploadToDrive, deleteMessages } = require('./driveUploader');
const { askForPhoto, askForSum, askForComment, finalizeRequest } = require('./messageUtils');

const bodyParser = require('body-parser');
app.use(bodyParser.json());

// Стейт для обработки данных по chatId
const userState = {}; // { [chatId]: { stage: 'photo' | 'sum' | 'comment', row: 123, ... } }

if (!process.env.GAS_WEB_APP_URL) {
  console.error('❌ GAS_WEB_APP_URL не определён! Проверь .env');
  process.exit(1);
}

// Webhook от Telegram
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // 🔘 Обработка нажатий кнопок
    if (body.callback_query) {
      const data = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + body.callback_query.from.username;

      console.log(`➡️ Кнопка: ${data}, от: ${username}`);

      if (data.startsWith('start_')) {
        const row = data.split('_')[1];

        // Ответ на кнопку "Принято в работу"
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Заявка #${row} взята в работу пользователем ${username}`,
          reply_to_message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Выполнено ✅', callback_data: `done_${row}` },
                { text: 'Ожидает поставки ⏳', callback_data: `delay_${row}` },
                { text: 'Отмена ❌', callback_data: `cancel_${row}` },
              ]
            ]
          }
        });

        // Обновление GAS (обновление статуса и исполнителя)
        await axios.post(process.env.GAS_WEB_APP_URL, {
          data: 'start',
          row,
          username,
          message_id: messageId
        });
      }

      // Кнопка "Выполнено" — начинаем сбор информации
      else if (data.startsWith('done_')) {
        const row = data.split('_')[1];
        userState[chatId] = { stage: 'photo', row, username, messageId };

        await askForPhoto(chatId);
      }

      return res.sendStatus(200);
    }

    // 📸 Получено фото от пользователя
    if (body.message?.photo && userState[body.message.chat.id]?.stage === 'photo') {
      const chatId = body.message.chat.id;
      const fileId = body.message.photo[body.message.photo.length - 1].file_id;

      const localPath = await downloadTelegramFile(fileId);
      const photoUrl = await uploadToDrive(localPath);

      userState[chatId].photoUrl = photoUrl;
      userState[chatId].stage = 'sum';

      fs.unlinkSync(localPath); // Удаляем временный файл

      await askForSum(chatId);
      return res.sendStatus(200);
    }

    // 💰 Получена сумма
    if (body.message?.text && userState[body.message.chat.id]?.stage === 'sum') {
      const chatId = body.message.chat.id;
      const sum = body.message.text.trim();

      if (!/^\d+$/g.test(sum)) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '❗️Введите только число, без символов.'
        });
        return res.sendStatus(200);
      }

      userState[chatId].sum = sum;
      userState[chatId].stage = 'comment';

      await askForComment(chatId);
      return res.sendStatus(200);
    }

    // 💬 Получен комментарий
    if (body.message?.text && userState[body.message.chat.id]?.stage === 'comment') {
      const chatId = body.message.chat.id;
      const comment = body.message.text.trim();
      userState[chatId].comment = comment;

      // Финал: отправка в GAS
      await finalizeRequest(chatId, userState[chatId]);
      delete userState[chatId];

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Ошибка в webhook:', error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
