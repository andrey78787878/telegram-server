const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const { BOT_TOKEN, TELEGRAM_API, TELEGRAM_FILE_API, GOOGLE_SCRIPT_URL, FOLDER_ID, PORT } = require("./config");
const { downloadTelegramFile, uploadToDrive } = require("./utils/driveUploader");
const { scheduleDeletion } = require("./utils/messageUtils");

const app = express();
app.use(express.json());

const userStates = new Map();   // текущие шаги исполнителей per chat
const serviceMsgs = new Map();  // для удаления через минуту

// Отправить сообщение
async function sendMessage(chat_id, text, opts = {}) {
  const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id, text, ...opts, parse_mode: "HTML"
  });
  return res.data.result;
}

// Отредактировать текст + клавиатуру
async function editMessage(chat_id, message_id, text, keyboard) {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id, message_id, text,
    reply_markup: keyboard ? { inline_keyboard: [keyboard] } : undefined,
    parse_mode: "HTML"
  });
}

// Webhook
app.post("/webhook", async (req, res) => {
  const { message, callback_query } = req.body;
  try {
    // 1) Обработка нажатия кнопок
    if (callback_query) {
      const data = callback_query.data;           // e.g. "accept:5"
      const [action, row] = data.split(":");
      const chat_id    = callback_query.message.chat.id;
      const message_id = callback_query.message.message_id;
      const username   = callback_query.from.username
                         ? `@${callback_query.from.username}`
                         : callback_query.from.first_name;

      // Принято в работу
      if (action === "accept") {
        // редактируем исходное сообщение
        const original = callback_query.message.text;
        await editMessage(chat_id, message_id,
          `${original}\n\n👤 Исполнитель: ${username}`,
          [ { text: "В работе 🟢", callback_data: `working:${row}` } ]
        );
        // записываем в таблицу
        await axios.post(GOOGLE_SCRIPT_URL, { row, status: "В работе", executor: username });
      }

      // Переход в «В работе» (расширяем кнопки)
      if (action === "working") {
        await editMessage(chat_id, message_id,
          callback_query.message.text,
          [
            { text: "✅ Выполнено", callback_data: `done:${row}` },
            { text: "🕓 Ожидает поставки", callback_data: `awaiting:${row}` },
            { text: "❌ Отмена", callback_data: `cancel:${row}` }
          ]
        );
      }

      // Начать цепочку «Выполнено»
      if (action === "done") {
        // сохраняем состояние
        userStates.set(chat_id, { step: "photo", row: Number(row), executor: username, msgIds: [message_id] });
        // запросить фото
        const sent = await sendMessage(chat_id, "📸 Пришлите фото выполненных работ:", { reply_to_message_id: message_id });
        serviceMsgs.set(chat_id, [sent.message_id]);
      }

      return res.sendStatus(200);
    }

    // 2) Фото от исполнителя
    if (message && message.photo && userStates.has(message.chat.id)) {
      const state = userStates.get(message.chat.id);
      if (state.step !== "photo") return res.sendStatus(200);

      // скачать и залить в Drive
      const fileId = message.photo.at(-1).file_id;
      const localPath = await downloadTelegramFile(fileId);
      const driveUrl   = await uploadToDrive(localPath, `done_${state.row}.jpg`, FOLDER_ID);
      fs.unlinkSync(localPath);

      state.photo = driveUrl;
      state.step  = "sum";
      state.msgIds.push(message.message_id);

      const sent = await sendMessage(message.chat.id, "💰 Укажите сумму работ (числом):", { reply_to_message_id: message.message_id });
      state.msgIds.push(sent.message_id);
      return res.sendStatus(200);
    }

    // 3) Получение суммы
    if (message && message.text && userStates.has(message.chat.id)) {
      const state = userStates.get(message.chat.id);
      if (state.step === "sum") {
        state.sum = message.text.trim();
        state.step = "comment";
        state.msgIds.push(message.message_id);

        const sent = await sendMessage(message.chat.id, "💬 Оставьте комментарий (что сделано):", { reply_to_message_id: message.message_id });
        state.msgIds.push(sent.message_id);
        return res.sendStatus(200);
      }
    }

    // 4) Получение комментария и финализация
    if (message && message.text && userStates.has(message.chat.id)) {
      const state = userStates.get(message.chat.id);
      if (state.step === "comment") {
        state.comment = message.text.trim();
        state.msgIds.push(message.message_id);

        // записать в таблицу
        await axios.post(GOOGLE_SCRIPT_URL, {
          row: state.row,
          photo: state.photo,
          sum: state.sum,
          comment: state.comment,
          executor: state.executor,
          status: "Выполнено"
        });

        // отредактировать материнское сообщение
        const overdueText = ""; // можно передать из GAS, если нужно
        await editMessage(message.chat.id, state.msgIds[0],
          `📌 Заявка #${state.row} закрыта.\n` +
          `📎 Фото: ${state.photo}\n` +
          `💰 Сумма: ${state.sum} сум\n` +
          `👤 Исполнитель: ${state.executor}\n` +
          `✅ Статус: Выполнено\n` +
          `${overdueText}`
        );

        // итоговое подтверждение
        const final = await sendMessage(message.chat.id, `✅ Заявка #${state.row} закрыта.`);

        // удалить все сервисные сообщения через 60 сек
        scheduleDeletion(message.chat.id, state.msgIds.concat(final.message_id));

        userStates.delete(message.chat.id);
        serviceMsgs.delete(message.chat.id);
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("❌ webhook error:", e);
    res.sendStatus(500);
  }
});

// Запуск
app.listen(PORT, () => console.log(`✅ Server listening on ${PORT}`));

