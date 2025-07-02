const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { BOT_TOKEN, GOOGLE_SCRIPT_URL, FOLDER_ID } = require("./config");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const app = express();
app.use(express.json());

const userStates = new Map(); // Для отслеживания шагов исполнителя

// 🔁 Удаление сообщений через 60 сек
const scheduleDeletion = (chatId, messageIds) => {
  setTimeout(() => {
    messageIds.forEach(id =>
      axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: id,
      }).catch(() => {})
    );
  }, 60000);
};

// 📩 Отправка сообщения с кнопками
const sendMessageWithButtons = (chatId, text, buttons, replyToMessageId) => {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    reply_markup: { inline_keyboard: [buttons] },
    parse_mode: "HTML",
  });
};

// 🔄 Редактирование сообщения
const editMessage = (chatId, messageId, newText, buttons) => {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    reply_markup: buttons ? { inline_keyboard: [buttons] } : undefined,
    parse_mode: "HTML",
  });
};

// 🖼️ Скачивание фото
const downloadTelegramFile = async (fileId) => {
  const { data: { result } } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const fileUrl = `${TELEGRAM_FILE_API}/${result.file_path}`;
  const filePath = path.join(__dirname, "photo.jpg");

  const writer = fs.createWriteStream(filePath);
  const response = await axios({ url: fileUrl, method: "GET", responseType: "stream" });
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", () => resolve(filePath));
    writer.on("error", reject);
  });
};

// 📤 Загрузка фото на Google Диск
const uploadToGoogleDrive = async (filePath, filename) => {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("filename", filename);
  form.append("folderId", FOLDER_ID);

  const response = await axios.post(GOOGLE_SCRIPT_URL, form, {
    headers: form.getHeaders(),
  });

  return response.data.url;
};

// 🧠 Хендлер обновлений
app.post("/webhook", async (req, res) => {
  const body = req.body;
  const msg = body.message || body.callback_query?.message;
  const callbackData = body.callback_query?.data;
  const chatId = msg?.chat.id;
  const messageId = msg?.message_id;
  const username = msg?.from?.username ? `@${msg.from.username}` : "Без ника";

  // 💬 Callback кнопок
  if (callbackData) {
    const [action, row] = callbackData.split(":");

    if (action === "accept") {
      const originalText = msg.text;
      await editMessage(chatId, messageId, `${originalText}\n\n👤 Исполнитель: ${username}`, [
        { text: "В работе 🟢", callback_data: `working:${row}` },
      ]);
      await axios.post(GOOGLE_SCRIPT_URL, {
        row,
        status: "В работе",
        executor: username,
      });
      return res.sendStatus(200);
    }

    if (action === "working") {
      await sendMessageWithButtons(chatId, "Выберите действие:", [
        { text: "✅ Выполнено", callback_data: `done:${row}` },
        { text: "🕐 Ожидает поставки", callback_data: `awaiting:${row}` },
        { text: "❌ Отмена", callback_data: `cancel:${row}` },
      ], messageId);
      return res.sendStatus(200);
    }

    if (action === "done") {
      userStates.set(chatId, { step: "awaiting_photo", row, username, msgIds: [messageId] });
      const { data } = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "📸 Пришлите фото выполненных работ:",
        reply_to_message_id: messageId,
      });
      userStates.get(chatId).msgIds.push(data.message_id);
      return res.sendStatus(200);
    }
  }

  // 🧾 Получение фото
  if (msg?.photo && userStates.has(chatId)) {
    const state = userStates.get(chatId);
    if (state.step !== "awaiting_photo") return;

    const fileId = msg.photo.at(-1).file_id;
    const filePath = await downloadTelegramFile(fileId);
    const gDriveUrl = await uploadToGoogleDrive(filePath, `done_${state.row}.jpg`);
    fs.unlinkSync(filePath);

    state.photo = gDriveUrl;
    state.step = "awaiting_sum";
    state.msgIds.push(messageId);

    const { data } = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "💰 Укажите сумму работ:",
      reply_to_message_id: messageId,
    });
    state.msgIds.push(data.message_id);
    return res.sendStatus(200);
  }

  // 💰 Получение суммы
  if (msg?.text && userStates.has(chatId)) {
    const state = userStates.get(chatId);

    if (state.step === "awaiting_sum") {
      state.sum = msg.text;
      state.step = "awaiting_comment";
      state.msgIds.push(messageId);

      const { data } = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "💬 Введите комментарий:",
        reply_to_message_id: messageId,
      });
      state.msgIds.push(data.message_id);
      return res.sendStatus(200);
    }

    if (state.step === "awaiting_comment") {
      state.comment = msg.text;
      state.msgIds.push(messageId);

      // ✅ Отправка в таблицу
      await axios.post(GOOGLE_SCRIPT_URL, {
        row: state.row,
        photo: state.photo,
        sum: state.sum,
        comment: state.comment,
        executor: state.username,
        status: "Выполнено",
      });

      // 📩 Итоговое сообщение
      const finalMsg = `📌 Заявка #${state.row} закрыта.\n📎 Фото: ${state.photo}\n💰 Сумма: ${state.sum} сум\n👤 Исполнитель: ${state.username}\n✅ Статус: Выполнено\nПросрочка: рассчитывается`;

      const { data } = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: finalMsg,
      });

      state.msgIds.push(data.message_id);
      scheduleDeletion(chatId, state.msgIds);
      userStates.delete(chatId);
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
