const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const https = require("https");
const path = require("path");

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzv0rnfV8dRQaSUs97riFH_-taEqDsSDd1Hl5BkehGfCbIjti_jWLhTNiuXppJMYAo/exec";
const DISK_UPLOAD_FOLDER = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

let userState = {};

function sendMessage(chatId, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...options,
  });
}

function editMessage(chatId, messageId, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...options,
  });
}

function deleteMessage(chatId, messageId) {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId,
  });
}

function getFileLink(fileId) {
  return axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`)
    .then(res => TELEGRAM_FILE_API + "/" + res.data.result.file_path);
}

function downloadFile(fileUrl, filename) {
  return new Promise((resolve, reject) => {
    const filePath = path.join("/tmp", filename);
    const file = fs.createWriteStream(filePath);
    https.get(fileUrl, response => {
      response.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve(filePath));
      });
    }).on("error", reject);
  });
}

async function uploadToGoogleDrive(filePath, row) {
  const form = new FormData();
  form.append("photo", fs.createReadStream(filePath));
  form.append("row", row);

  const res = await axios.post(GOOGLE_SCRIPT_URL, form, {
    headers: form.getHeaders(),
  });

  return res.data.photoUrl;
}

app.post("/", async (req, res) => {
  const msg = req.body.message || req.body.callback_query?.message;
  const callback = req.body.callback_query;
  const chatId = msg.chat.id;

  if (callback) {
    const data = callback.data;
    const [action, row] = data.split("_");
    const username = callback.from.username;
    const messageId = msg.message_id;

    if (action === "accept") {
      // Принято в работу
      await editMessage(chatId, messageId, `📌 Заявка #${row}\n🟢 Статус: В работе\n👤 Исполнитель: @${username}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Выполнено", callback_data: `done_${row}` },
            { text: "🔄 Ожидает поставки", callback_data: `waiting_${row}` },
            { text: "❌ Отмена", callback_data: `cancel_${row}` }
          ]]
        }
      });

      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        status: "В работе",
        executor: username
      });

      return res.sendStatus(200);
    }

    if (action === "waiting") {
      await editMessage(chatId, messageId, `📌 Заявка #${row}\n🟡 Ожидает поставки\n👤 @${username}`);
      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        status: "Ожидает поставки",
        executor: username
      });
      return res.sendStatus(200);
    }

    if (action === "cancel") {
      await editMessage(chatId, messageId, `📌 Заявка #${row}\n⛔️ Отменена\n👤 @${username}`);
      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        status: "Отменена",
        executor: username
      });
      return res.sendStatus(200);
    }

    if (action === "done") {
      userState[chatId] = { step: "await_photo", row, parentMessageId: messageId, username };
      await sendMessage(chatId, "📸 Пришлите фото выполненных работ", { reply_to_message_id: messageId });
      return res.sendStatus(200);
    }
  }

  // Получение фото, суммы, комментария
  if (msg && userState[chatId]) {
    const state = userState[chatId];

    if (state.step === "await_photo" && msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileUrl = await getFileLink(fileId);
      const filePath = await downloadFile(fileUrl, `photo_${chatId}.jpg`);
      const photoUrl = await uploadToGoogleDrive(filePath, state.row);

      state.photoUrl = photoUrl;
      state.step = "await_sum";

      await sendMessage(chatId, "💰 Введите сумму выполненных работ");
    } else if (state.step === "await_sum" && msg.text) {
      state.sum = msg.text;
      state.step = "await_comment";
      await sendMessage(chatId, "💬 Добавьте комментарий исполнителя");
    } else if (state.step === "await_comment" && msg.text) {
      state.comment = msg.text;

      // Финальные действия
      await axios.post(GOOGLE_SCRIPT_URL, {
        row: state.row,
        status: "Выполнено",
        executor: state.username,
        photo: state.photoUrl,
        sum: state.sum,
        comment: state.comment
      });

      // Обновить заявку
      await editMessage(chatId, state.parentMessageId,
        `📌 Заявка #${state.row} закрыта.\n📎 Фото: ${state.photoUrl}\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: @${state.username}\n✅ Статус: Выполнено`
      );

      await sendMessage(chatId, "✅ Заявка закрыта. Спасибо!", {
        reply_to_message_id: state.parentMessageId
      });

      delete userState[chatId];
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot server is running on port ${PORT}`));
