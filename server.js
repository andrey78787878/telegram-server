const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";

app.post("/webhook", async (req, res) => {
  const callbackQuery = req.body.callback_query;

  if (!callbackQuery) return res.sendStatus(200);

  const { data, message, from } = callbackQuery;
  const chat_id = message.chat.id;
  const tgMessageId = message.message_id;
  const username = from.username || from.first_name || "неизвестно";

  // Принято в работу
  if (data.startsWith("accept_")) {
    try {
      // 1. Отправляем в Google Script
      await axios.post(GOOGLE_SCRIPT_URL, {
        message_id: tgMessageId,
        executor: username,
        response: "В работе"
      });

      // 2. Удаляем кнопки
      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id,
        message_id: tgMessageId,
        reply_markup: { inline_keyboard: [] }
      });

      // 3. Сообщение в чат
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `✅ Заявка принята в работу исполнителем: @${username}`
      });

      return res.send("OK");
    } catch (err) {
      console.error("Ошибка при обработке accept_*:", err.message);
      return res.sendStatus(500);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server started on port", PORT);
});

