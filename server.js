require('dotenv').config({ path: './.env' });

const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

const { BOT_TOKEN, TELEGRAM_API } = require('./config');
const driveUploader = require('./utils/driveUploader');
const {
  askForPhoto,
  askForSum,
  askForComment,
  finalizeRequest,
  buildFollowUpButtons,
  editMessageText
} = require('./messageUtils');

const { downloadTelegramFile, uploadToDrive } = require('./utils/driveUploader');

const bodyParser = require('body-parser');
app.use(bodyParser.json());

// Стейт
const userState = {};

if (!process.env.GAS_WEB_APP_URL) {
  console.error('❌ GAS_WEB_APP_URL не определён! Проверь .env');
  process.exit(1);
}

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // 🔘 Обработка callback кнопок
    if (body.callback_query) {
      const callbackData = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + body.callback_query.from.username;

      let parsed;
      try {
        parsed = JSON.parse(callbackData);
      } catch {
        console.error('⚠️ Некорректный callback_data:', callbackData);
        return res.sendStatus(200);
      }

      const { action, messageId: originalMessageId, row } = parsed;

      console.log(`➡️ Кнопка: ${action}, от: ${username}`);

      if (action === 'in_progress') {
        // Отправляем в GAS
        const gasRes = await axios.post(process.env.GAS_WEB_APP_URL, {
          data: 'start',
          row,
          username,
          message_id: originalMessageId
        });

        // Обновляем сообщение
        await editMessageText(
          chatId,
          messageId,
          `✅ Заявка принята в работу\n👤 Исполнитель: ${username}`,
          buildFollowUpButtons(row)
        );

        return res.sendStatus(200);
      }

      if (action === 'completed') {
        userState[chatId] = { stage: 'photo', row, username, messageId };
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      // TODO: обработка delay и cancel — аналогично
    }

    // 📸 Фото
    if (body.message?.photo && userState[body.message.chat.id]?.stage === 'photo') {
      const chatId = body.message.chat.id;
      const fileId = body.message.photo.at(-1).file_id;

      const localPath = await downloadTelegramFile(fileId);
      const photoUrl = await uploadToDrive(localPath);

      userState[chatId].photoUrl = photoUrl;
      userState[chatId].stage = 'sum';

      fs.unlinkSync(localPath);
      await askForSum(chatId);
      return res.sendStatus(200);
    }

    // 💰 Сумма
    if (body.message?.text && userState[body.message.chat.id]?.stage === 'sum') {
      const chatId = body.message.chat.id;
      const sum = body.message.text.trim();

      if (!/^\d+$/g.test(sum)) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: '❗️Введите только число без символов.',
        });
        return res.sendStatus(200);
      }

      userState[chatId].sum = sum;
      userState[chatId].stage = 'comment';
      await askForComment(chatId);
      return res.sendStatus(200);
    }

    // 💬 Комментарий
    if (body.message?.text && userState[body.message.chat.id]?.stage === 'comment') {
      const chatId = body.message.chat.id;
      const comment = body.message.text.trim();

      userState[chatId].comment = comment;

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
