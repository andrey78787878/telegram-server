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

const cleanupMessage = (chat_id, message_id) => {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id,
      message_id
    }).catch((err) => console.error("Failed to delete message:", err.response?.data || err));
  }, 60000);
};

const getFileLink = async (fileId) => {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${res.data.result.file_path}`;
};

const uploadToDrive = async (url, filename) => {
  const res = await fetch(url);
  const buffer = await res.buffer();

  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
  const drive = google.drive({ version: "v3", auth: await auth.getClient() });

  const file = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [FOLDER_ID]
    },
    media: {
      mimeType: "image/jpeg",
      body: Buffer.from(buffer)
    }
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: {
      role: "reader",
      type: "anyone"
    }
  });

  return `https://drive.google.com/uc?id=${file.data.id}`;
};

app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("Incoming update:", JSON.stringify(body, null, 2));

  if (body.callback_query) {
    const data = body.callback_query.data;
    const chat_id = body.callback_query.message.chat.id;
    const message_id = body.callback_query.message.message_id;
    const from_user = body.callback_query.from.username || "без имени";

    if (data.startsWith("accept_")) {
      const row = data.split("_")[1];

      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        response: "Принято в работу",
        username: `@${from_user}`,
        message_id
      });

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Заявка #${row} принята в работу ✅`,
        reply_to_message_id: message_id
      });

      cleanupMessage(chat_id, message_id);
      cleanupMessage(chat_id, sent.data.result.message_id);
    } else if (data.startsWith("cancel_")) {
      const row = data.split("_")[1];

      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        response: "Отмена",
        username: `@${from_user}`,
        message_id
      });

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Заявка #${row} отменена ❌`,
        reply_to_message_id: message_id
      });

      cleanupMessage(chat_id, message_id);
      cleanupMessage(chat_id, sent.data.result.message_id);
    }
  } else if (body.message?.photo) {
    const chat_id = body.message.chat.id;
    const from_user = body.message.from.username || "без имени";
    const photo = body.message.photo.pop();
    const fileId = photo.file_id;
    const caption = body.message.caption || "";
    const rowMatch = caption.match(/#(\d+)/);
    const row = rowMatch ? rowMatch[1] : null;

    if (row) {
      const fileLink = await getFileLink(fileId);
      const gDriveUrl = await uploadToDrive(fileLink, `photo_${row}.jpg`);

      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        photo: gDriveUrl,
        username: `@${from_user}`
      });

      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Фото по заявке #${row} загружено и сохранено.`
      });

      cleanupMessage(chat_id, msg.data.result.message_id);
      cleanupMessage(chat_id, body.message.message_id);
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

