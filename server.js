const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const { uploadToDrive } = require("./utils/driveUploader");
const { updateSheet } = require("./utils/spreadsheet");
const { TELEGRAM_TOKEN, TELEGRAM_API, DRIVE_FOLDER_ID } = require("./config");

const app = express();
app.use(express.json());

const pending = {}; // message_id -> { step, row, photo, sum, comment, username }

app.post("/webhook", async (req, res) => {
  const msg = req.body.message || req.body.callback_query?.message;
  const chat_id = msg.chat.id;
  const message_id = msg.message_id;
  const data = req.body.callback_query?.data;

  if (data?.startsWith("work:")) {
    const [_, row, username] = data.split(":");
    await updateSheet({ row, status: "В работе", executor: username });
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: `Заявка #${row} принята в работу исполнителем: @${username}`,
      reply_to_message_id: message_id
    });
    return res.send("OK");
  }

  if (data?.startsWith("done:")) {
    const [_, row, username] = data.split(":");
    pending[chat_id] = { step: "photo", row, username };
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      text: `Пожалуйста, пришлите фото выполненной работы.`
    });
    return res.send("OK");
  }

  const userInput = pending[chat_id];
  if (userInput) {
    if (userInput.step === "photo" && msg.photo) {
      const fileId = msg.photo.at(-1).file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

      const photoLink = await uploadToDrive(fileUrl);
      userInput.photo = photoLink;
      userInput.step = "sum";
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Введите сумму работ:`
      });
      return res.send("OK");
    }
    if (userInput.step === "sum" && msg.text) {
      userInput.sum = msg.text;
      userInput.step = "comment";
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Добавьте комментарий:`
      });
      return res.send("OK");
    }
    if (userInput.step === "comment" && msg.text) {
      userInput.comment = msg.text;
      const { row, photo, sum, comment, username } = userInput;
      await updateSheet({ row, photo, sum, comment, executor: username });

      const deadline = await updateSheet({ row, getOverdue: true });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `Заявка #${row} закрыта. 💰 Сумма: ${sum} сум 👤 Исполнитель: @${username} 🔴 Просрочка: ${deadline} дн.`
      });
      delete pending[chat_id];
      return res.send("OK");
    }
  }

  res.send("IGNORED");
});

app.listen(3000, () => console.log("Bot server running on port 3000"));
