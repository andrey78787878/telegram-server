// server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

const sessions = new Map();

app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("Incoming update:", JSON.stringify(body, null, 2));

  if (body.callback_query) {
    const data = body.callback_query.data;
    const chat_id = body.callback_query.message.chat.id;
    const message_id = body.callback_query.message.message_id;

    if (data.startsWith("accept_")) {
      const row = data.split("_")[1];
      const status = "Выполнено";

      sessions.set(chat_id, {
        step: "awaiting_photo",
        row,
        message_id
      });
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "Пожалуйста, отправьте фото выполненных работ в ответ на это сообщение.",
        reply_to_message_id: message_id
      });
    }
  }

  if (body.message && sessions.has(body.message.chat.id)) {
    const session = sessions.get(body.message.chat.id);
    const chat_id = body.message.chat.id;
    const from_user = body.message.from.username || "без имени";
    const row = session.row;

    if (session.step === "awaiting_photo" && body.message.photo) {
      const file_id = body.message.photo.pop().file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      const fileName = `photo_${Date.now()}.jpg`;

      const driveLink = await uploadToDrive(fileUrl, fileName);

      session.photo = driveLink;
      session.step = "awaiting_sum";
      sessions.set(chat_id, session);

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "Теперь укажите сумму затрат.",
        reply_to_message_id: body.message.message_id
      });
    } else if (session.step === "awaiting_sum" && body.message.text) {
      session.sum = body.message.text;
      session.step = "awaiting_comment";
      sessions.set(chat_id, session);

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "Добавьте комментарий к выполненной заявке.",
        reply_to_message_id: body.message.message_id
      });
    } else if (session.step === "awaiting_comment" && body.message.text) {
      session.comment = body.message.text;

      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        response: "Выполнено",
        photo: session.photo,
        sum: session.sum,
        comment: session.comment,
        username: `@${from_user}`,
        message_id: session.message_id
      });

      sessions.delete(chat_id);

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Заявка #${row} закрыта.\n💰 Сумма: ${session.sum} сум\n👤 Исполнитель: @${from_user}\n🔴 Просрочка: 1 дн.`
      });
    }
  }

  res.sendStatus(200);
});

async function uploadToDrive(fileUrl, fileName) {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "service-account.json"),
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  const drive = google.drive({ version: "v3", auth: await auth.getClient() });

  const response = await fetch(fileUrl);
  const buffer = await response.buffer();

  const fileMetadata = {
    name: fileName,
    parents: [FOLDER_ID]
  };
  const media = {
    mimeType: "image/jpeg",
    body: Buffer.from(buffer)
  };

  const file = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: "id"
  });

  const fileId = file.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone"
    }
  });

  return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
