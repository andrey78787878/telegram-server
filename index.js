const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const fs = require("fs");
const { google } = require("googleapis");
const { Readable } = require("stream");

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

const getTelegramFileUrl = (filePath) =>
  `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: ["https://www.googleapis.com/auth/drive"]
});

const executorWaitingMap = new Map();

async function uploadToDrive(fileUrl) {
  const authClient = await auth.getClient();
  const drive = google.drive({ version: "v3", auth: authClient });

  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const buffer = Buffer.from(response.data);
  const fileName = `photo_${Date.now()}.jpg`;

  const fileMetadata = {
    name: fileName,
    parents: [FOLDER_ID],
  };

  const media = {
    mimeType: "image/jpeg",
    body: Readable.from(buffer),
  };

  const uploaded = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: "id",
  });

  await drive.permissions.create({
    fileId: uploaded.data.id,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  const file = await drive.files.get({
    fileId: uploaded.data.id,
    fields: "webViewLink",
  });

  return file.data;
}

app.post("/", async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const callbackData = body.callback_query.data;
    const chat_id = body.callback_query.message.chat.id;
    const message_id = body.callback_query.message.message_id;

    const statuses = [
      "Принято в работу",
      "В работе",
      "Ожидает поставки",
      "Ожидает подрядчика",
      "Выполнено",
      "Отмена"
    ];

    if (callbackData === "Принято в работу") {
      const sheetResponse = await axios.get(`${GOOGLE_SCRIPT_URL}?message_id=${message_id}`);
      const { rowIndex } = sheetResponse.data;

      if (rowIndex != null) {
        executorWaitingMap.set(`${chat_id}_${message_id}`, { rowIndex });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
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

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: callbackData === "Выполнено"
          ? "Пожалуйста, отправьте фото выполненных работ в ответ на это сообщение."
          : `Статус обновлён на: ${callbackData}`,
        reply_to_message_id: message_id
      });
    }

    return res.sendStatus(200);
  }

  if (body.message && body.message.text) {
    const chat_id = body.message.chat.id;
    const reply_id = body.message.reply_to_message?.message_id;

    if (reply_id) {
      const key = `${chat_id}_${reply_id}`;
      const executorData = executorWaitingMap.get(key);

      if (executorData) {
        const executorName = body.message.text;
        const { rowIndex } = executorData;

        executorWaitingMap.delete(key);

        await axios.post(GOOGLE_SCRIPT_URL, {
          row: rowIndex,
          executor: executorName,
          response: "В работе"
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `Статус обновлён на: В работе\nИсполнитель: ${executorName}`,
          reply_to_message_id: reply_id
        });
      }
    }

    return res.sendStatus(200);
  }

  if (body.message && body.message.photo) {
    const chat_id = body.message.chat.id;
    const message_id = body.message.reply_to_message?.message_id || null;
    const fileId = body.message.photo.at(-1).file_id;

    if (!message_id) return res.sendStatus(200);

    try {
      const { data: fileInfo } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const fileUrl = getTelegramFileUrl(fileInfo.result.file_path);

      await new Promise(resolve => setTimeout(resolve, 1000));

      const response = await uploadToDrive(fileUrl);
      const publicUrl = response.webViewLink;

      const sheetResponse = await axios.get(`${GOOGLE_SCRIPT_URL}?message_id=${message_id}`);
      const { rowIndex } = sheetResponse.data;

      if (rowIndex == null) return res.sendStatus(200);

      await axios.post(GOOGLE_SCRIPT_URL, {
        row: rowIndex,
        photo: publicUrl,
        response: "Выполнено"
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "✅ Фото получено и прикреплено к заявке."
      });
    } catch (error) {
      console.error("Ошибка при загрузке фото:", error);
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("✅ Сервер запущен на порту 3000");
});
