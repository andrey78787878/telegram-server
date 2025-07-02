const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const app = express();
const PORT = process.env.PORT || 10000;

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_URL = "https://script.google.com/macros/s/AKfycbwrkw-Pd2HzOUStWt4nAkLUFdGzLsWJRQjdLcv4xAjVEdXFAqKknGnbCnM7Epa5ps7g/exec; // ⬅️ ВСТАВЬ СЮДА СВОЙ URL Google Apps Script

app.use(bodyParser.json());

// Установка webhook
axios
  .get(`${TELEGRAM_API}/setWebhook?url=https://telegram-server-3cyz.onrender.com`)
  .then((res) => console.log("✅ Webhook установлен:", res.data))
  .catch((err) => console.error("❌ Ошибка установки webhook:", err.response?.data || err.message));

app.post("/", async (req, res) => {
  const body = req.body;
  console.log(JSON.stringify(body, null, 2));

  if (body.message) {
    const chat_id = body.message.chat.id;
    const text = body.message.text;
    const username = body.message.from.username;

    if (text === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "Добро пожаловать! Вот пример заявки:",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Принято в работу",
                callback_data: "accept_125", // номер заявки
              },
            ],
          ],
        },
      });
    }
  }

  if (body.callback_query) {
    const callback = body.callback_query;
    const data = callback.data;
    const chat_id = callback.message.chat.id;
    const message_id = callback.message.message_id;
    const username = callback.from.username;

    console.log("🔘 Нажата кнопка:", data);

    if (data.startsWith("accept_")) {
      const row = data.split("_")[1];
      const text = `🟢 Заявка #${row} В работе`;

      // Обновить сообщение
      await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        chat_id,
        message_id,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "В работе 🟢", callback_data: "noop" },
            ],
            [
              { text: "✅ Выполнено", callback_data: `done_${row}` },
              { text: "⏳ Ожидает поставки", callback_data: `waiting_${row}` },
              { text: "❌ Отмена", callback_data: `cancel_${row}` },
            ],
          ],
        },
      });

      // Отправка данных в Google Apps Script
      try {
        const payload = {
          row,
          status: "В работе",
          executor: `@${username}`,
        };
        await axios.post(GAS_URL, payload);
        console.log("📤 Данные отправлены в Google Таблицу.");
      } catch (error) {
        console.error("❌ Ошибка при отправке в Google Таблицу:", error.response?.data || error.message);
      }

      // Ответ пользователю
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
        callback_query_id: callback.id,
        text: "Заявка принята в работу",
      });
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
