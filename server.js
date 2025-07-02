const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const { uploadToDrive } = require("./utils/driveUploader");
const { deleteMessageAfterDelay } = require("./utils/messageUtils");
const app = express();

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzHx2W12QKGmzh8MWwNYMyeWu0tVw-PZbm3R5Oq2yz5yU5Cpe1M0m_lOiNeSXcwGNww/exec";

app.use(express.json());

const userState = {}; // для отслеживания этапов закрытия заявки

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { data, message, from } = body.callback_query;
    const chat_id = message.chat.id;
    const message_id = message.message_id;

    // Принято в работу
    if (data.startsWith("work:")) {
      const [_, row, username] = data.split(":");

      await axios.post(WEB_APP_URL, {
        row,
        status: "В работе",
        executor: username,
        message_id
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `✅ Заявка #${row} принята в работу исполнителем: @${username}`,
        reply_to_message_id: message_id
      });

      return res.send("OK");
    }

    // Выполнено — начать цепочку загрузки
    if (data.startsWith("done:")) {
      const [_, row] = data.split(":");

      userState[chat_id] = {
        step: "awaiting_photo",
        row,
        message_id,
        username: from.username
      };

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "📷 Пришлите фото выполненных работ"
      });

      deleteMessageAfterDelay(chat_id, sent.data.result.message_id);
      return res.send("OK");
    }
  }

  // Обработка сообщений (фото, сумма, комментарий)
  if (body.message) {
    const msg = body.message;
    const chat_id = msg.chat.id;

    if (!userState[chat_id]) return res.send("OK");
    const state = userState[chat_id];

    if (state.step === "awaiting_photo" && msg.photo) {
      const file_id = msg.photo[msg.photo.length - 1].file_id;
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
      const file_path = fileRes.data.result.file_path;
      const file_url = `${TELEGRAM_FILE_API}/${file_path}`;

      const photoLink = await uploadToDrive(file_url, `Заявка_${state.row}.jpg`);
      state.photo = photoLink;
      state.step = "awaiting_sum";

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "💰 Укажите сумму работ в сумах"
      });

      deleteMessageAfterDelay(chat_id, msg.message_id);
      deleteMessageAfterDelay(chat_id, sent.data.result.message_id);
      return res.send("OK");
    }

    if (state.step === "awaiting_sum" && msg.text) {
      state.sum = msg.text;
      state.step = "awaiting_comment";

      const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: "💬 Добавьте комментарий (что было сделано)"
      });

      deleteMessageAfterDelay(chat_id, msg.message_id);
      deleteMessageAfterDelay(chat_id, sent.data.result.message_id);
      return res.send("OK");
    }

    if (state.step === "awaiting_comment" && msg.text) {
      state.comment = msg.text;
      state.step = "completed";

      const { row, photo, sum, comment, username, message_id } = state;
      const response = await axios.post(WEB_APP_URL, {
        row,
        photo,
        sum,
        comment,
        executor: username,
        message_id,
        status: "Выполнено"
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: `✅ Заявка #${row} закрыта.\n💰 Сумма: ${sum} сум\n👤 Исполнитель: @${username}`
      });

      delete userState[chat_id];
      deleteMessageAfterDelay(chat_id, msg.message_id);
      return res.send("OK");
    }
  }

  return res.send("OK");
});

app.listen(3000, () => console.log("🚀 Server started on port 3000"));
