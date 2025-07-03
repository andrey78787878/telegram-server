// 📦 server.js — Telegram бот с интеграцией в Google Таблицу

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

// === Константы ===
const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzv0rnfV8dRQaSUs97riFH_-taEqDsSDd1Hl5BkehGfCbIjti_jWLhTNiuXppJMYAo/exec";
const CHAT_CLEANUP_DELAY_MS = 60000; // 1 минута

// Служебное хранилище временных состояний пользователя
const state = {};

// === Обработка входящих обновлений от Telegram ===
app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Обработка инлайн-кнопок (callback_query)
  if (body.callback_query) {
    const query = body.callback_query;
    const data = query.data;
    const chat_id = query.message.chat.id;
    const message_id = query.message.message_id;
    const username = query.from.username || "Без имени";

    if (data === "accept") {
      await sendToGAS({ row: null, message_id, response: "В работе", username });
      await editMessage(chat_id, message_id, `📌 Заявка принята в работу исполнителем: @${username}`);
      await updateButtons(chat_id, message_id);
    }

    if (data === "done") {
      state[chat_id] = { step: "photo", message_id, username };
      const msg = await sendMessage(chat_id, "📷 Пришли фото выполненных работ");
      scheduleDelete(chat_id, msg.message_id);
    }

    return res.sendStatus(200);
  }

  // Обработка фото, суммы, комментария
  if (body.message && body.message.photo) {
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

  if (body.message && body.message.text) {
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
    reply_markup: buttons ? { inline_keyboard: [buttons] } : undefined,
  });
  return res.data.result;
}

async function editMessage(chat_id, message_id, text, buttons) {
  await axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id,
    message_id,
    text,
    reply_markup: buttons ? { inline_keyboard: [buttons] } : undefined,
  });
}

async function updateButtons(chat_id, message_id) {
  const buttons = [
    { text: "Выполнено", callback_data: "done" },
    { text: "Ожидает поставки", callback_data: "wait" },
    { text: "Отмена", callback_data: "cancel" },
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
  const { photo_file_id, sum, comment, message_id, username } = state[chat_id];

  // Получаем файл и загружаем на диск через твой старый код (опущено для краткости)
  const photoUrl = await getTelegramFileUrl(photo_file_id);
  const photoDriveLink = await uploadPhotoToDrive(photoUrl); // замените на свою реализацию

  const payload = {
    message_id,
    response: "Выполнено",
    sum,
    comment,
    username,
    photo: photoDriveLink,
  };

  await sendToGAS(payload);
  await sendMessage(chat_id, `✅ Заявка закрыта.\n💰 ${sum} сум\n📎 Фото: ${photoDriveLink}\n📝 Комментарий: ${comment}`);
}

async function getTelegramFileUrl(file_id) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${res.data.result.file_path}`;
}

async function uploadPhotoToDrive(url) {
  // Твоя логика загрузки фото на Google Диск и получения публичной ссылки
  return url; // временно возвращаем URL Telegram (заменить)
}

// === Запуск сервера ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));

