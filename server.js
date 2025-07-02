const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 10000;

// 🔐 ВСТАВЬ СЮДА СВОЙ ТОКЕН
const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const WEBHOOK_URL = "https://telegram-server-3cyz.onrender.com/webhook"; // ← URL твоего Render сервера

app.use(bodyParser.json());

// Проверка сервера
app.get("/", (req, res) => {
  res.send("🤖 Telegram бот работает!");
});

// Webhook обработчик
app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("📩 Webhook payload:", JSON.stringify(body, null, 2));

  try {
    const message = body.message || body.callback_query?.message;
    const chatId = message.chat.id;
    const text = body.message?.text;
    const callbackQuery = body.callback_query;

    // Команда /start
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
    }

    // Обработка кнопки
    if (callbackQuery) {
      const callbackData = callbackQuery.data;
      const callbackId = callbackQuery.id;

      console.log("🔘 Нажата кнопка:", callbackData);

      if (callbackData === "accept") {
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId,
          text: "✅ Заявка принята!",
          show_alert: false
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "🟢 Заявка принята в работу!"
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка обработки:", err);
    res.sendStatus(500);
  }
});

// Установка webhook
async function setWebhook() {
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
