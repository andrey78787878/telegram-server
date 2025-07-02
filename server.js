const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const {
  BOT_TOKEN,
  TELEGRAM_API,
  TELEGRAM_FILE_API,
  GOOGLE_SCRIPT_URL,
  FOLDER_ID,
  PORT
} = require("./config");
const { updateGoogleSheet } = require("./utils/spreadsheet");
const {
  sendMessage,
  sendPhoto,
  deleteMessage,
  editMessageReplyMarkup
} = require("./utils/messageUtils");

const app = express();
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const message = req.body.message || req.body.callback_query?.message;
  const callbackQuery = req.body.callback_query;
  const chatId = message.chat.id;

  try {
    if (callbackQuery) {
      const data = callbackQuery.data;
      const messageId = message.message_id;
      const username = callbackQuery.from.username || "Неизвестно";

      if (data === "accepted") {
        await updateGoogleSheet({
          row: messageId,
          status: "В работе",
          executor: username
        });

        await sendMessage(chatId, `✅ Заявка принята в работу исполнителем @${username}`, {
          reply_to_message_id: messageId
        });

        await editMessageReplyMarkup(chatId, messageId, {
          inline_keyboard: [
            [
              { text: "Выполнено ✅", callback_data: "done" },
              { text: "Ожидает поставки 📦", callback_data: "waiting" },
              { text: "Отмена ❌", callback_data: "cancelled" }
            ]
          ]
        });

        return res.sendStatus(200);
      }

      if (data === "cancelled") {
        await updateGoogleSheet({
          row: messageId,
          status: "Отменено",
          executor: username
        });

        await sendMessage(chatId, `⛔️ Заявка отменена исполнителем @${username}`, {
          reply_to_message_id: messageId
        });

        await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
        return res.sendStatus(200);
      }

      if (data === "waiting") {
        await updateGoogleSheet({
          row: messageId,
          status: "Ожидает поставки",
          executor: username
        });

        await sendMessage(chatId, `📦 Заявка ожидает поставки. Исполнитель: @${username}`, {
          reply_to_message_id: messageId
        });

        return res.sendStatus(200);
      }

      if (data === "done") {
        await sendMessage(chatId, "📸 Отправьте фото выполненной заявки", {
          reply_to_message_id: messageId
        });
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      const messageId = message.reply_to_message?.message_id;
      if (!messageId) return res.sendStatus(200);

      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

      const photoRes = await axios.get(fileUrl, { responseType: "stream" });

      const form = new FormData();
      form.append("photo", photoRes.data, {
        filename: `done-${Date.now()}.jpg`
      });
      form.append("row", messageId);
      form.append("folderId", FOLDER_ID);

      const uploadRes = await axios.post(GOOGLE_SCRIPT_URL, form, {
        headers: form.getHeaders()
      });

      const photoLink = uploadRes.data?.photoUrl || "Ссылка недоступна";

      await updateGoogleSheet({
        row: messageId,
        photo: photoLink
      });

      await sendMessage(chatId, `✅ Фото получено и сохранено: ${photoLink}`, {
        reply_to_message_id: messageId
      });

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Ошибка обработки запроса:", error);
    res.sendStatus(500);
  }
});

app.post("/webhook", (req, res) => {
  console.log("Webhook payload:", JSON.stringify(req.body));
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log(`✅ Server listening on ${PORT}`);

  const WEBHOOK_URL = "https://telegram-server-3cyz.onrender.com/webhook";

  try {
    const res = await axios.post(`${TELEGRAM_API}/setWebhook`, null, {
      params: { url: WEBHOOK_URL }
    });
    console.log("✅ Webhook установлен:", res.data);
  } catch (err) {
    console.error("❌ Ошибка установки webhook:", err.response?.data || err.message);
  }
});

