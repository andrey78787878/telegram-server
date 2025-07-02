const axios = require("axios");
const bodyParser = require("body-parser");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { downloadPhoto, uploadToDrive } = require("./utils/driveUploader");
const { TELEGRAM_API, GOOGLE_SCRIPT_URL, FOLDER_ID } = require("./config");

const app = express();
app.use(bodyParser.json());

const conversations = new Map();
const serviceMessages = new Map();

const sendMessage = async (chat_id, text, options = {}) => {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id,
    text,
    ...options,
  });
};

const editMessage = async (chat_id, message_id, text, options = {}) => {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id,
    message_id,
    text,
    ...options,
  });
};

const deleteMessage = async (chat_id, message_id) => {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id,
    message_id,
  });
};

const updateGoogleSheet = async (data) => {
  return axios.post(GOOGLE_SCRIPT_URL, data);
};

app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("Received:", JSON.stringify(body));

  if (body.callback_query) {
    const { id, data, message, from } = body.callback_query;
    const chat_id = message.chat.id;
    const message_id = message.message_id;
    const row = Number(message.text.match(/#(\d+)/)?.[1]);
    const username = from.username || from.first_name;

    if (!row) return res.sendStatus(200);

    if (data === "accept") {
      await editMessage(chat_id, message_id, `${message.text}\n🟢 В работе
👤 Исполнитель: @${username}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Выполнено", callback_data: `done_${row}` },
              { text: "🕓 Ожидает поставки", callback_data: `wait_${row}` },
              { text: "❌ Отмена", callback_data: `cancel_${row}` }
            ]
          ]
        }
      });

      await updateGoogleSheet({ row, status: "В работе", executor: `@${username}` });
    }

    if (data.startsWith("done_")) {
      conversations.set(chat_id, { step: "await_photo", row, executor: `@${username}`, message_id });
      const reply = await sendMessage(chat_id, "📸 Пришлите фото выполненных работ", { reply_to_message_id: message_id });
      serviceMessages.set(chat_id, [reply.data.result.message_id]);
    }

    return res.sendStatus(200);
  }

  if (body.message && body.message.photo) {
    const chat_id = body.message.chat.id;
    const file_id = body.message.photo.at(-1).file_id;

    const context = conversations.get(chat_id);
    if (!context || context.step !== "await_photo") return res.sendStatus(200);

    const photoPath = await downloadPhoto(file_id);
    const photoLink = await uploadToDrive(photoPath, FOLDER_ID);
    fs.unlinkSync(photoPath);

    context.photo = photoLink;
    context.step = "await_sum";
    conversations.set(chat_id, context);

    const reply = await sendMessage(chat_id, "💰 Укажите сумму работ (в сум)");
    serviceMessages.get(chat_id).push(reply.data.result.message_id);
    return res.sendStatus(200);
  }

  if (body.message && body.message.text && conversations.has(body.message.chat.id)) {
    const chat_id = body.message.chat.id;
    const text = body.message.text;
    const context = conversations.get(chat_id);

    if (context.step === "await_sum") {
      context.sum = text;
      context.step = "await_comment";
      conversations.set(chat_id, context);
      const reply = await sendMessage(chat_id, "💬 Добавьте комментарий (опишите, что было сделано)");
      serviceMessages.get(chat_id).push(reply.data.result.message_id);
      return res.sendStatus(200);
    }

    if (context.step === "await_comment") {
      context.comment = text;

      const { row, photo, sum, comment, executor, message_id } = context;
      await updateGoogleSheet({ row, photo, sum, comment, executor, status: "Выполнено" });

      const overdue = `Просрочка: ? дн.`; // Можно получить из GAS, если нужно точно
      await editMessage(chat_id, message_id,
        `📌 Заявка #${row} закрыта.\n📎 Фото: ${photo}\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${executor}\n✅ Статус: Выполнено\n${overdue}`);

      const finalMsg = await sendMessage(chat_id, `✅ Заявка #${row} закрыта.`);

      const toDelete = [...(serviceMessages.get(chat_id) || []), body.message.message_id, finalMsg.data.result.message_id];
      setTimeout(() => {
        toDelete.forEach(msgId => deleteMessage(chat_id, msgId).catch(() => {}));
      }, 60 * 1000);

      conversations.delete(chat_id);
      serviceMessages.delete(chat_id);
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log("Server running on port 3000"));
