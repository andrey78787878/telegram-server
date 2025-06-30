const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const https = require("https");
const path = require("path");

const app = express();
app.use(express.json());

const BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const GOOGLE_SCRIPT_URL = "YOUR_GOOGLE_SCRIPT_URL";

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const executorWaitingMap = new Map();

// ============ Основной webhook ============
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.message) {
    const msg = body.message;
    const chatId = msg.chat.id;
    const msgId = msg.message_id;

    // Если есть фото
    if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const fileLink = await getFileLink(fileId);
      await sendToGoogleSheet({ photoUrl: fileLink, chatId });

      // Удалим фото через 60 сек
      setTimeout(() => {
        deleteMessage(chatId, msgId);
      }, 60_000);
    }

    // Если обычное сообщение
    if (msg.text) {
      if (executorWaitingMap.has(chatId)) {
        const row = executorWaitingMap.get(chatId);
        await sendToGoogleSheet({ chatId, executor: msg.text, row });
        executorWaitingMap.delete(chatId);

        const sent = await sendMessage(chatId, "Ответ получен. Спасибо!");
        setTimeout(() => deleteMessage(chatId, sent.message_id), 60_000);
      }

      // Удалим текстовое сообщение через 60 сек
      setTimeout(() => {
        deleteMessage(chatId, msgId);
      }, 60_000);
    }
  }

  if (body.callback_query) {
    const { message, data, from, id } = body.callback_query;
    const chatId = message.chat.id;
    const msgId = message.message_id;

    // Удалим сообщение с кнопкой
    setTimeout(() => {
      deleteMessage(chatId, msgId);
    }, 60_000);

    // Пример: data = "row=12&action=executor"
    const params = Object.fromEntries(new URLSearchParams(data));
    if (params.action === "executor" && params.row) {
      executorWaitingMap.set(chatId, params.row);
      await sendMessage(chatId, "Пожалуйста, укажите имя исполнителя:");
    } else if (params.action === "done" && params.row) {
      await sendToGoogleSheet({ row: params.row, status: "Выполнено" });
      await sendMessage(chatId, "Отметили как выполнено.");
    }

    // Ответ на callback
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: id,
    });
  }

  res.sendStatus(200);
});

// ============ Утилиты ============

async function sendMessage(chatId, text) {
  const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
  });
  return res.data.result;
}

async function deleteMessage(chatId, messageId) {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (err) {
    console.error("❌ Не удалось удалить сообщение:", err.response?.data || err);
  }
}

async function getFileLink(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = res.data.result.file_path;
  return `${TELEGRAM_FILE_API}/${filePath}`;
}

async function sendToGoogleSheet(payload) {
  try {
    await axios.post(GOOGLE_SCRIPT_URL, payload);
  } catch (err) {
    console.error("❌ Ошибка при отправке в Google Таблицу:", err.message);
  }
}

// ============ Запуск сервера ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Сервер запущен на порту", PORT);
});

