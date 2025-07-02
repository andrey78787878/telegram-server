const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 10000;

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbw.../exec"; // ВСТАВЬ СЮДА СВОЙ URL

app.use(bodyParser.json());

// Проверка
app.get("/", (req, res) => {
  res.send("🤖 Telegram бот работает");
});

// Webhook
app.post("/webhook", async (req, res) => {
  console.log("📥 Webhook получен:", JSON.stringify(req.body, null, 2));

  const message = req.body.message || req.body.callback_query?.message;
  const callbackQuery = req.body.callback_query;

  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const username = message.from?.username || callbackQuery?.from?.username || "Без имени";

  try {
    if (req.body.message?.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Привет! Выберите действие:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Принять в работу", callback_data: "accept_122" }]
          ]
        }
      });
    }

    if (callbackQuery) {
      const callbackData = callbackQuery.data;
      const callbackId = callbackQuery.id;

      console.log("🔘 Нажата кнопка:", callbackData);

      if (callbackData.startsWith("accept_")) {
        const row = callbackData.split("_")[1];

        // 1. Ответ на callback
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: callbackId,
          text: "Принято в работу!",
          show_alert: false
        });

        // 2. Обновление inline-кнопки
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: message.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: `В работе 🟢 (${username})`, callback_data: "noop" }]
            ]
          }
        });

        // 3. Отправка в Google Таблицу
        await axios.post(GAS_WEB_APP_URL, {
          status: "В работе",
          message_id: message.message_id,
          row,
          username
        });

        console.log("📤 Данные отправлены в Google Таблицу.");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Установка webhook
async function setWebhook() {
  const WEBHOOK_URL = "https://telegram-server-3cyz.onrender.com/webhook"; // ← замени при необходимости
  try {
    const res = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: WEBHOOK_URL
    });

    if (res.data.ok) {
      console.log("✅ Webhook установлен");
    } else {
      console.error("❌ Ошибка установки webhook:", res.data);
    }
  } catch (err) {
    console.error("❌ Ошибка при установке webhook:", err.response?.data || err.message);
  }
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  setWebhook();
});
