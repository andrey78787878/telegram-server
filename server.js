const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { google } = require("googleapis");
const { updateGoogleSheet } = require("./utils/updateGoogleSheet");
const { getDrivePublicUrl, uploadToDrive } = require("./utils/driveUploader");
require("dotenv").config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const STATE = {}; // Храним состояния пользователей (ожидаем фото, сумму, коммент)

// Удаление сообщений через 60 сек
async function deleteAfter(chat_id, message_id) {
  setTimeout(() => {
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id,
      message_id,
    });
  }, 60000);
}

// Ответ на callback_query
async function answerCallbackQuery(callback_query_id) {
  return axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
    callback_query_id,
  });
}

// Обработка кнопок
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { id, from, message, data } = body.callback_query;
    const chat_id = message.chat.id;
    const message_id = message.message_id;

    if (!data) return res.sendStatus(200);

    const [action, row] = data.split("_");
    const username = from.username ? `@${from.username}` : from.first_name;

    switch (action) {
      case "accept": {
        // Обновить статус на В работе
        await updateGoogleSheet({ row, status: "В работе", executor: username });

        // Редактировать сообщение
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id,
          message_id,
          reply_markup: {
            inline_keyboard: [
              [
                { text: `В работе 🟢`, callback_data: "noop" },
                { text: "Выполнено ✅", callback_data: `done_${row}` },
                { text: "Ожидает поставки ⏳", callback_data: `delay_${row}` },
                { text: "Отмена ❌", callback_data: `cancel_${row}` },
              ],
            ],
          },
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `Заявка #${row} принята в работу исполнителем ${username}`,
          reply_to_message_id: message_id,
        });
        break;
      }

      case "done": {
        STATE[chat_id] = { step: "photo", row, message_id, username };
        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: "📷 Пожалуйста, отправьте фото выполненных работ:",
        });
        STATE[chat_id].msgToDelete = [reply.data.result.message_id];
        break;
      }

      case "noop": {
        await answerCallbackQuery(id);
        break;
      }

      default: {
        console.log("⚠️ Некорректный callback_data:", data);
        await answerCallbackQuery(id);
        break;
      }
    }
  } else if (body.message && STATE[body.message.chat.id]) {
    const chat_id = body.message.chat.id;
    const userState = STATE[chat_id];
    const message_id = body.message.message_id;
    const row = userState.row;
    const executor = userState.username;

    // Фото
    if (userState.step === "photo" && body.message.photo) {
      const file_id = body.message.photo.pop().file_id;
      const fileResp = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
      const file_path = fileResp.data.result.file_path;
      const file_url = `${TELEGRAM_FILE_API}/${file_path}`;

      const photoPath = path.resolve(__dirname, `photo_${chat_id}.jpg`);
      const writer = fs.createWriteStream(photoPath);
      const imageStream = await axios.get(file_url, { responseType: "stream" });
      imageStream.data.pipe(writer);

      await new Promise((resolve) => writer.on("finish", resolve));

      const uploadedFile = await uploadToDrive(photoPath, `Выполнено_${row}.jpg`);
      const publicUrl = await getDrivePublicUrl(uploadedFile.id);
      fs.unlinkSync(photoPath);

      userState.photo = publicUrl;
      userState.step = "sum";

      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "💰 Укажите сумму работ:",
      });
      userState.msgToDelete.push(message_id, msg.data.result.message_id);
    }
    // Сумма
    else if (userState.step === "sum") {
      userState.sum = body.message.text;
      userState.step = "comment";

      const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "💬 Добавьте комментарий:",
      });
      userState.msgToDelete.push(message_id, msg.data.result.message_id);
    }
    // Комментарий
    else if (userState.step === "comment") {
      userState.comment = body.message.text;
      userState.msgToDelete.push(message_id);

      await updateGoogleSheet({
        row,
        photo: userState.photo,
        sum: userState.sum,
        comment: userState.comment,
        executor,
        status: "Выполнено",
      });

      // Получаем просрочку и проблему из таблицы
      const response = await axios.post(process.env.GOOGLE_SCRIPT_URL, {
        row,
        action: "get_final_info",
      });

      const { delay, problem } = response.data;

      const finalText = `📌 Заявка #${row} закрыта\n📝 Проблема: ${problem}\n💬 Комментарий: ${userState.comment}\n📎 Фото: [ссылка](${userState.photo})\n💰 Сумма: ${userState.sum} сум\n👤 Исполнитель: ${executor}\n✅ Статус: Выполнено\n⏱ Просрочка: ${delay} дн.`;

      // Обновить материнское сообщение заявки
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id,
        message_id: userState.message_id,
        text: finalText,
        parse_mode: "Markdown",
      });

      // Удалить промежуточные сообщения
      for (const mid of userState.msgToDelete) {
        deleteAfter(chat_id, mid);
      }

      delete STATE[chat_id];
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log("✅ Server started on port 3000"));
