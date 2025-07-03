const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// === Константы ===
const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzv0rnfV8dRQaSUs97riFH_-taEqDsSDd1Hl5BkehGfCbIjti_jWLhTNiuXppJMYAo/exec";
const CHAT_CLEANUP_DELAY_MS = 60000;

// Временное хранилище
const state = {};

// === Webhook от Telegram ===
app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("📥 Входящий апдейт:", JSON.stringify(body, null, 2));

  // === Callback кнопки
  if (body.callback_query) {
    const query = body.callback_query;
    const [action, row] = query.data.split("_");
    const chat_id = query.message.chat.id;
    const message_id = query.message.message_id;
    const username = query.from.username || "Без имени";

    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: query.id,
    });

    if (action === "accept") {
      await sendToGAS({ row, message_id, response: "В работе", username });
      await editMessage(chat_id, message_id, `📌 Заявка принята в работу исполнителем: @${username}`);
      await updateButtons(chat_id, message_id, row);
    }

    if (action === "done") {
      state[chat_id] = { step: "photo", message_id, username, row };
      const msg = await sendMessage(chat_id, "📷 Пришли фото выполненных работ");
      scheduleDelete(chat_id, msg.message_id);
    }

    if (action === "cancel") {
      await sendToGAS({ row, message_id, response: "Отменено", username });
      await editMessage(chat_id, message_id, `❌ Заявка отменена исполнителем: @${username}`);
    }

    if (action === "wait") {
      await sendToGAS({ row, message_id, response: "Ожидает поставки", username });
      await editMessage(chat_id, message_id, `⏳ Заявка ожидает поставки. Ответственный: @${username}`);
    }

    return res.sendStatus(200);
  }

  // === Фото
  if (body.message?.photo) {
    const chat_id = body.message.chat.id;
    const file_id = body.message.photo.at(-1).file_id;

    if (state[chat_id]?.step === "photo") {
      state[chat_id].photo_file_id = file_id;
      state[chat_id].step = "sum";
      const msg = await sendMessage(chat_id, "💰 Введи сумму выполненных работ в сумах:");
      scheduleDelete(chat_id, msg.message_id);
    }
    return res.sendStatus(200);
  }

  // === Сумма и комментарий
  if (body.message?.text) {
    const chat_id = body.message.chat.id;
    const text = body.message.text;
    const user = state[chat_id];
    if (!user) return res.sendStatus(200);

    if (user.step === "sum") {
      user.sum = text;
      user.step = "comment";
      const msg = await sendMessage(chat_id, "📝 Введи комментарий (что было сделано):");
      scheduleDelete(chat_id, msg.message_id);
    } else if (user.step === "comment") {
      user.comment = text;
      await handleFinalSubmission(chat_id);
      delete state[chat_id];
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

// === Функции ===

async function sendToGAS(payload) {
  try {
    await axios.post(GOOGLE_SCRIPT_URL, payload);
  } catch (err) {
    console.error("❌ Ошибка при отправке в GAS:", err.response?.data || err.message);
  }
}

async function sendMessage(chat_id, text, buttons) {
  const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    parse_mode: "HTML",
    reply_markup: buttons ? { inline_keyboard: [buttons] } : undefined,
  });
  return res.data.result;
}

async function editMessage(chat_id, message_id, text, buttons) {
  await axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id,
    message_id,
    text,
    parse_mode: "HTML",
    reply_markup: buttons ? { inline_keyboard: [buttons] } : undefined,
  });
}

async function updateButtons(chat_id, message_id, row) {
  const buttons = [
    [
      { text: "✅ Выполнено", callback_data: `done_${row}` },
      { text: "⏳ Ожидает поставки", callback_data: `wait_${row}` },
      { text: "❌ Отмена", callback_data: `cancel_${row}` }
    ]
  ];
  await editMessage(chat_id, message_id, `🟢 Заявка в работе`, buttons);
}

function scheduleDelete(chat_id, message_id) {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id,
      message_id,
    }).catch(() => {});
  }, CHAT_CLEANUP_DELAY_MS);
}

async function handleFinalSubmission(chat_id) {
  const { photo_file_id, sum, comment, message_id, username, row } = state[chat_id];

  const photoUrl = await getTelegramFileUrl(photo_file_id);
  const photoDriveLink = await uploadPhotoToDrive(photoUrl, message_id, username, row);
  const overdue = await getOverdueDays(row);

  const payload = {
    message_id,
    row,
    response: "Выполнено",
    sum,
    comment,
    username,
    photo: photoDriveLink
  };

  await sendToGAS(payload);

  const finalMessage = `
📌 Заявка #${row} закрыта.
📎 Фото: ${photoDriveLink}
💰 Сумма: ${sum} сум
👤 Исполнитель: @${username}
✅ Статус: Выполнено
Просрочка: ${overdue} дн.
  `.trim();

  await editMessage(chat_id, message_id, finalMessage);
}

async function getTelegramFileUrl(file_id) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
  return `${TELEGRAM_FILE_API}/${res.data.result.file_path}`;
}

async function uploadPhotoToDrive(photoUrl, message_id, username, row) {
  try {
    const res = await axios.post(GOOGLE_SCRIPT_URL, {
      photo: photoUrl,
      message_id,
      username,
      row,
    });
    return res.data?.photoLink || photoUrl;
  } catch (err) {
    console.error("❌ Ошибка при загрузке фото на Google Диск:", err.response?.data || err.message);
    return photoUrl;
  }
}

async function getOverdueDays(row) {
  try {
    const res = await axios.post(GOOGLE_SCRIPT_URL, {
      requestDeadline: true,
      row,
    });
    const deadline = new Date(res.data.deadline);
    const now = new Date();
    const days = Math.floor((now - deadline) / (1000 * 60 * 60 * 24));
    return days > 0 ? days : 0;
  } catch (err) {
    return "-";
  }
}

// === Запуск ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
