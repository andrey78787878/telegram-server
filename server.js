const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 10000;

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyFKlzM5JgcBOss238ofdwi_TcC4TIGMPOwpFb86yvV9YDHoXnjqYIs9U2EMg-TX2ql/exec"; // ← Убедись, что этот URL публичен

app.use(bodyParser.json());

// Проверка работоспособности
app.get("/", (req, res) => {
  res.send("🤖 Telegram бот работает");
});

// Обработка webhook
app.post("/webhook", async (req, res) => {
  console.log("📥 Webhook получен:", JSON.stringify(req.body, null, 2));

  const message = req.body.message || req.body.callback_query?.message;
  const callbackQuery = req.body.callback_query;

  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const username = req.body.message?.from?.username || callbackQuery?.from?.username || "Без имени";

  try {
    // Обработка /start
    if (req.body.message?.text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Привет! Выберите действие:",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Принять в работу", callback_data: "accept_122" },
              { text: "❌ Отмена", callback_data: "cancel_122" }
            ]
          ]
        }
      });
    }

    // Обработка нажатия на кнопку
    if (callbackQuery) {
      const callbackData = callbackQuery.data;
      const callbackId = callbackQuery.id;

      console.log("🔘 Нажата кнопка:", callbackData);

      // ✅ Всегда немедленно отвечаем Telegram
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: "✅ Обрабатываем...",
        show_alert: false
      });

      // Принимаем в работу
      if (callbackData.startsWith("accept_")) {
        const row = callbackData.split("_")[1];

        // Обновление кнопки
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: `🟢 В работе (${username})`, callback_data: "noop" }
              ]
            ]
          }
        });

        // Отправка данных в Google Таблицу
        await axios.post(GAS_WEB_APP_URL, {
          status: "В работе",
          message_id: messageId,
          row,
          username
        });

        console.log("📤 Данные отправлены в Google Таблицу.");
      }

      // Отмена
      if (callbackData.startsWith("cancel_")) {
        const row = callbackData.split("_")[1];

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [
              [
                { text: `❌ Отменено (${username})`, callback_data: "noop" }
              ]
            ]
          }
        });

        await axios.post(GAS_WEB_APP_URL, {
          status: "Отменено",
          message_id: messageId,
          row,
          username
        });

        console.log("📤 Отмена отправлена в Google Таблицу.");
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка обработки:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Установка webhook
async function setWebhook() {
  const WEBHOOK_URL = "https://telegram-server-3cyz.onrender.com/webhook";
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
    console.error("❌ Ошибка при установке webhook:", err.response?.data || err.message);
  }
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  setWebhook();
});

