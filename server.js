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
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwRVFxHQ6-H1g3zu2KZz7GkqlvBPQXFrjEgrR1FHhzxBmrrp2UnsCyXByc3U2X19DI/exec";
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: ["https://www.googleapis.com/auth/drive"]
});

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

  // Inline кнопки — обновление статуса
  if (body.callback_query) {
    const callbackData = body.callback_query.data;
    const chat_id = body.callback_query.message.chat.id;
    const message_id = body.callback_query.message.message_id;

    const statuses = ["Принято в работу", "В работе", "Ожидает поставки", "Ожидает подрядчика", "Выполнено", "Отмена"];

    if (statuses.includes(callbackData)) {
      // Обновляем статус в Google Таблице
      await axios.post(GOOGLE_SCRIPT_URL, {
        row: null,
        response: callbackData,
        message_id
      });

      // Ответ пользователю
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: callbackData === "Выполнено" ? "Пожалуйста, отправьте фото выполненных работ в ответ на это сообщение." : `Статус обновлён на: ${callbackData}`,
        reply_to_message_id: message_id
      });
    }

    return res.sendStatus(200);
  }

  // Обработка фото
  if (body.message && body.message.photo) {
    const chat_id = body.message.chat.id;
    const message_id = body.message.reply_to_message?.message_id || null;
    const fileId = body.message.photo.at(-1).file_id;

    if (!message_id) return res.sendStatus(200);

    try {
      const { data: fileInfo } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;

      const response = await uploadToDrive(fileUrl);
      const publicUrl = response.webViewLink;

      // Найти строку по message_id
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
