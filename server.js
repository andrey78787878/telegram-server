const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";
const executorWaitingMap = new Map();

async function sendTempMessage({ chat_id, text, reply_to_message_id }) {
  const message = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    reply_to_message_id
  });

  const message_id = message.data.result.message_id;

  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id,
      message_id
    }).catch(() => {});
  }, 60000);
}

app.post("/", async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: body.callback_query.id
    });

    const callbackData = body.callback_query.data;
    const chat_id = body.callback_query.message.chat.id;
    const message_id = body.callback_query.message.message_id;

    const statuses = ["Принято в работу", "В работе", "Ожидает поставки", "Ожидает подрядчика", "Выполнено", "Отмена"];

    if (callbackData === "Принято в работу") {
      const sheetResponse = await axios.get(`${GOOGLE_SCRIPT_URL}?message_id=${message_id}`);
      const { rowIndex } = sheetResponse.data;

      if (rowIndex != null) {
        executorWaitingMap.set(`${chat_id}_${message_id}`, { rowIndex });

        await sendTempMessage({
          chat_id,
          text: "Пожалуйста, введите имя и/или компанию исполнителя:",
          reply_to_message_id: message_id
        });
      }

      return res.sendStatus(200);
    }

    if (statuses.includes(callbackData)) {
      await axios.post(GOOGLE_SCRIPT_URL, {
        row: null,
        response: callbackData,
        message_id
      });

      await sendTempMessage({
        chat_id,
        text: callbackData === "Выполнено" ?
          "Пожалуйста, отправьте фото выполненных работ в ответ на это сообщение." :
          `Статус обновлён на: ${callbackData}`,
        reply_to_message_id: message_id
      });
    }

    setTimeout(() => {
      axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id,
        message_id
      }).catch(() => {});
    }, 60000);

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log("Server is running on port", PORT);
});
