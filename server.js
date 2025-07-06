const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const { uploadTelegramPhotoToDrive } = require("./utils/driveUploader");
const { updateGoogleSheet } = require("./utils/spreadsheet");

const userState = {}; // состояние пользователя по chatId

const buildFollowUpButtons = (row) => ({
  inline_keyboard: [
    [
      { text: "Выполнено ✅", callback_data: JSON.stringify({ action: "completed", row }) },
      { text: "Ожидает поставки ⏳", callback_data: JSON.stringify({ action: "delayed", row }) },
      { text: "Отмена ❌", callback_data: JSON.stringify({ action: "cancelled", row }) }
    ]
  ]
});

const editMessageText = async (chatId, messageId, text, reply_markup) => {
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
};

const sendMessage = async (chatId, text, options = {}) => {
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
};

const askForPhoto = async (chatId) => sendMessage(chatId, "📸 Пришлите фото выполненных работ");
const askForSum = async (chatId) => sendMessage(chatId, "💰 Введите сумму работ в сумах:");
const askForComment = async (chatId) => sendMessage(chatId, "💬 Добавьте комментарий:");

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const body = req.body;

  try {
    if (body.callback_query) {
      const data = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + body.callback_query.from.username;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        console.warn("⚠️ Некорректный callback_data:", data);
        return res.sendStatus(200);
      }

      const { action, row, messageId: originalMessageId } = parsed;

      if (action === "in_progress") {
        await axios.post(GAS_WEB_APP_URL, {
          data: 'start',
          row,
          username,
          message_id: originalMessageId
        });

        await editMessageText(
          chatId,
          messageId,
          `🟢 Заявка #${row} в работе.\n👤 Исполнитель: ${username}`,
          buildFollowUpButtons(row)
        );

        return res.sendStatus(200);
      }

      if (action === "completed") {
        userState[chatId] = { stage: 'photo', row, username, messageId };
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      if (action === "delayed" || action === "cancelled") {
        await axios.post(GAS_WEB_APP_URL, {
          data: action,
          row,
          username,
          message_id: originalMessageId
        });

        await editMessageText(
          chatId,
          messageId,
          `📌 Заявка #${row}\n⚠️ Статус: ${action === 'delayed' ? 'Ожидает поставки' : 'Отменена'}\n👤 Исполнитель: ${username}`
        );
        return res.sendStatus(200);
      }
    }

    if (body.message?.photo && userState[body.message.chat.id]?.stage === 'photo') {
      const chatId = body.message.chat.id;
      const fileId = body.message.photo.at(-1).file_id;

      const photoUrl = await uploadTelegramPhotoToDrive(fileId, BOT_TOKEN);
      userState[chatId].photo = photoUrl;
      userState[chatId].stage = 'sum';

      await askForSum(chatId);
      return res.sendStatus(200);
    }

    if (body.message?.text && userState[body.message.chat.id]?.stage === 'sum') {
      const chatId = body.message.chat.id;
      const sum = body.message.text.trim();

      if (!/^\d+$/.test(sum)) {
        await sendMessage(chatId, "❗ Введите только число без символов.");
        return res.sendStatus(200);
      }

      userState[chatId].sum = sum;
      userState[chatId].stage = 'comment';

      await askForComment(chatId);
      return res.sendStatus(200);
    }

    if (body.message?.text && userState[body.message.chat.id]?.stage === 'comment') {
      const chatId = body.message.chat.id;
      const comment = body.message.text.trim();
      const { row, photo, sum, username, messageId } = userState[chatId];

      await updateGoogleSheet({ row, photo, sum, comment, username, message_id: messageId });

      await sendMessage(chatId, `✅ Заявка #${row} закрыта.\n📎 Фото: <a href="${photo}">ссылка</a>\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${username}`);

      delete userState[chatId];
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка обработки запроса:", err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
