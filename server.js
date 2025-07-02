const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const { uploadToDrive } = require("./utils/driveUploader");
const { updateStatus, updateCompletionData } = require("./utils/spreadsheet");
const app = express();
app.use(bodyParser.json());

const TELEGRAM_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

app.post("/webhook", async (req, res) => {
  const message = req.body.message || req.body.callback_query?.message;
  const callbackData = req.body.callback_query?.data;
  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (callbackData === "in_progress") {
    await updateStatus(messageId, "В работе", "@username");
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "Выбор зафиксирован: заявка принята в работу.",
    });
  }

  if (callbackData === "done") {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "Отправьте фото выполненных работ.",
    });
    // дальнейшая логика обработки фото, суммы и комментария
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log("Server running on port 3000"));
