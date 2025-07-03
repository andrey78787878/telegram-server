const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const TELEGRAM_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const GAS_URL = "https://script.google.com/macros/s/AKfycbwlJy3XL7EF7rcou2fe7O4uC2cVlmeYfM87D-M6ji4KyU0Ds0sp_SiOuT643vIhCwps/exec";

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  const callbackQuery = req.body.callback_query;

  try {
    if (callbackQuery) {
      const { id, data, message } = callbackQuery;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const username = callbackQuery.from.username || "Без имени";
      const userId = callbackQuery.from.id;

      if (data.startsWith("accept_")) {
        const row = data.split("_")[1];

        // 1. Отправляем в GAS
        await axios.post(GAS_URL, {
          message_id: messageId,
          row,
          status: "В работе",
          username
        });

        // 2. Редактируем материнское сообщение (добавим статус и исполнителя)
        const originalText = message.text;

        const updatedText = originalText + `\n\n🟢 В работе\n👷 Исполнитель: @${username}`;

        const newButtons = {
          inline_keyboard: [[
            { text: "Выполнено ✅", callback_data: `done_${row}_${username}` },
            { text: "Ожидает поставки 🕒", callback_data: `pending_${row}_${username}` },
            { text: "Отмена ❌", callback_data: `cancel_${row}_${username}` }
          ]]
        };

        // 3. Редактируем сообщение
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: updatedText,
          reply_markup: JSON.stringify(newButtons),
          parse_mode: "HTML"
        });

        // 4. Ответ на callback (всплывающее уведомление)
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: id,
          text: "Заявка принята в работу ✅"
        });
      }

      // Можно добавить обработку done_, pending_, cancel_ по аналогии
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Ошибка:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log("🤖 Сервер запущен на порту 3000");
});
