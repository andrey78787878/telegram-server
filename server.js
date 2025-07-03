const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const app = express();
const PORT = 3000;

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SPREADSHEET_URL = "https://script.google.com/macros/s/AKfycbwlJy3XL7EF7rcou2fe7O4uC2cVlmeYfM87D-M6ji4KyU0Ds0sp_SiOuT643vIhCwps/exec";

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const callback = body.callback_query;
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    const username = callback.from.username ? `@${callback.from.username}` : callback.from.first_name;
    const row = data.split("_")[1]; // Пример: accept_131 => 131
    const action = data.split("_")[0];

    if (action === "accept") {
      // ✅ Шаг 1: отправить ответ дочерним сообщением
      const replyText = `👤 Исполнитель: ${username}\n🔄 Заявка принята в работу.`;
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: replyText,
        reply_to_message_id: messageId,
      });

      // ✅ Шаг 2: обновить материнское сообщение
      const updatedText = `${callback.message.text}\n\n🟢 Статус: В работе\n👤 Исполнитель: ${username}`;
      const newInlineKeyboard = {
        inline_keyboard: [
          [
            { text: "✅ Выполнено", callback_data: `done_${row}` },
            { text: "📦 Ожидает поставки", callback_data: `wait_${row}` },
            { text: "❌ Отмена", callback_data: `cancel_${row}` },
          ],
        ],
      };

      try {
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: updatedText,
          parse_mode: "HTML",
          reply_markup: newInlineKeyboard,
        });
      } catch (err) {
        console.error("❌ Ошибка при редактировании сообщения:", err.response?.data || err.message);
      }

      // ✅ Шаг 3: обновить Google Таблицу
      try {
        await axios.post(SPREADSHEET_URL, {
          row,
          status: "В работе",
          executor: username,
        });
      } catch (err) {
        console.error("❌ Ошибка при обновлении таблицы:", err.message);
      }

      return res.sendStatus(200);
    }

    // Заглушка для будущей логики
    if (["done", "wait", "cancel"].includes(action)) {
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
