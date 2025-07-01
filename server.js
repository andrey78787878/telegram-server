const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const stream = require("stream");

const app = express();
app.use(express.json());

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "service-account.json"),
  scopes: SCOPES,
});

const drive = google.drive({ version: "v3", auth });

const userStates = {};

app.post("/webhook", async (req, res) => {
  const body = req.body;
  const callback = body.callback_query;
  const msg = body.message;
  const from = callback ? callback.from : msg?.from;
  const chatId = callback ? callback.message.chat.id : msg?.chat.id;

  try {
    if (callback) {
      const [action, row] = callback.data.split("_");
      const messageId = callback.message.message_id;
      const username = from.username || from.first_name || "";

      if (action === "accept") {
        await axios.post(GOOGLE_SCRIPT_URL, {
          row,
          message_id: messageId,
          response: "Принято в работу",
          username,
        });

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "Статус обновлён: Принято в работу",
        });
      } else if (action === "done") {
        userStates[chatId] = { step: "photo", row, message_id: messageId, username };
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "Пожалуйста, отправьте фото."
        });
      }
    } else if (msg?.photo && userStates[chatId]?.step === "photo") {
      const photos = msg.photo;
      const fileId = photos[photos.length - 1].file_id;
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

      const fileName = `photo_${Date.now()}.jpg`;
      const response = await axios.get(fileUrl, { responseType: "stream" });
      const bufferStream = new stream.PassThrough();
      response.data.pipe(bufferStream);

      const uploadRes = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [FOLDER_ID],
        },
        media: {
          mimeType: "image/jpeg",
          body: bufferStream,
        },
        fields: "id",
      });

      const fileIdUploaded = uploadRes.data.id;

      await drive.permissions.create({
        fileId: fileIdUploaded,
        requestBody: {
          role: "reader",
          type: "anyone",
        },
      });

      const fileLink = `https://drive.google.com/uc?id=${fileIdUploaded}`;

      userStates[chatId].photo = fileLink;
      userStates[chatId].step = "sum";

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Фото загружено. Теперь введите сумму."
      });
    } else if (msg?.text && userStates[chatId]?.step === "sum") {
      userStates[chatId].sum = msg.text;
      userStates[chatId].step = "comment";

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Спасибо. Теперь введите комментарий."
      });
    } else if (msg?.text && userStates[chatId]?.step === "comment") {
      const { row, message_id, username, photo, sum } = userStates[chatId];
      const comment = msg.text;

      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        message_id,
        response: "Выполнено",
        photo,
        sum,
        comment,
        username,
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `Заявка #${row} закрыта. 💰 Сумма: ${sum} сум\n👤 Исполнитель: @${username}`
      });

      delete userStates[chatId];
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Ошибка обработки запроса:", err);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log("Сервер запущен на порту 3000");
});
