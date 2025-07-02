const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 10000;

const BOT_TOKEN = "ТВОЙ_ТОКЕН_ЗДЕСЬ"; // ← замени на свой
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.use(bodyParser.json());

// Проверка сервера
app.get("/", (req, res) => {
  res.send("🤖 Telegram бот работает");
});

// Главный обработчик webhook
app.post("/webhook", async (req, res) => {
  console.log("📥 Получен webhook:", JSON.stringify(req.body, null, 2));

  const message = req.body.message || req.body.callback_query?.message;
  const callbackQuery = req.body.callback_query;

  if (!message) {
    console.log("❗ Нет message в теле запроса");
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text;

  try {
    if (text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Привет! Нажми кнопку ниже:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Принять в работу", callback_data: "accept" }]
          ]
        }
      });
    } else if (callbackQuery) {
      const callbackData = callbackQuery.data;
      const callbackId = callbackQuery.id;

      console.log("🔘 Нажата кнопка:", callbackData);

      if (callbackData === "accept") {
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId,
          text: "Заявка принята!",
          show_alert: false
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "✅ Заявка принята в работу!"
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка обработки запроса:", err);
    res.sendStatus(500);
  }
});

// Установка webhook
async function setWebhook() {
  const WEBHOOK_URL = "https://telegram-server-3cyz.onrender.com/webhook"; // ← проверь свой URL

  try {
    const res = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: WEBHOOK_URL
    });

    if (res.data.ok) {
      console.log("✅ Webhook установлен:", res.data);
    } else {
      console.error("❌ Ошибка установки webhook:", res.data);
    }
  } catch (err) {
    console.error("❌ Ошибка установки webhook:", err.response?.data || err);
  }
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  setWebhook();
});
