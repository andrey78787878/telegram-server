import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();
app.use(bodyParser.json());

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";

const userStates = {};

// Кнопки после "Принято в работу" (без "Принято в работу" и "Выполнено")
const statusButtonsAfterAccept = [
  { text: "В работе", callback_data: "В работе" },
  { text: "Ожидает поставки", callback_data: "Ожидает поставки" },
  { text: "Отмена", callback_data: "Отмена" }
];

// Полный список статусов для начального меню (используется только при необходимости)
const allStatusButtons = [
  { text: "Принято в работу", callback_data: "Принято в работу" },
  { text: "В работе", callback_data: "В работе" },
  { text: "Ожидает поставки", callback_data: "Ожидает поставки" },
  { text: "Выполнено", callback_data: "Выполнено" },
  { text: "Отмена", callback_data: "Отмена" }
];

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Обработка нажатий кнопок
    if (body.callback_query) {
      const callbackData = body.callback_query.data;
      const chat_id = body.callback_query.message.chat.id;
      const message_id = body.callback_query.message.message_id;
      const from_user = body.callback_query.from;

      // Формат callback: accept_117 или cancel_117
      const match = callbackData.match(/(accept|cancel)_(\d+)/);
      if (match) {
        const action = match[1];
        const row = Number(match[2]);

        if (action === "cancel") {
          await axios.post(GOOGLE_SCRIPT_URL, { row, response: "Отмена", message_id });
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id,
            text: `Заявка #${row} отменена.`,
            reply_to_message_id: message_id
          });
          return res.sendStatus(200);
        }

        if (action === "accept") {
          await axios.post(GOOGLE_SCRIPT_URL, { row, response: "Принято в работу", message_id });

          // Кнопки после "Принято в работу"
          const keyboard = {
            inline_keyboard: [
              statusButtonsAfterAccept.map(btn => ({
                text: btn.text,
                callback_data: `${btn.callback_data}_${row}`
              }))
            ]
          };

          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id,
            text: `Статус заявки #${row} обновлён на "Принято в работу". Выберите следующий статус:`,
            reply_to_message_id: message_id,
            reply_markup: JSON.stringify(keyboard)
          });

          return res.sendStatus(200);
        }
      }

      // Обработка статусов с форматом Статус_номер
      const statusMatch = callbackData.match(/^(.+?)_(\d+)$/);
      if (statusMatch) {
        const status = statusMatch[1];
        const row = Number(statusMatch[2]);

        if (status === "Отмена") {
          await axios.post(GOOGLE_SCRIPT_URL, { row, response: "Отмена", message_id });
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id,
            text: `Заявка #${row} отменена.`,
            reply_to_message_id: message_id
          });
          return res.sendStatus(200);
        }

        if (status === "Выполнено") {
          userStates[chat_id] = {
            step: "request_photo",
            row,
            originalMessageId: message_id,
            tempMsgs: []
          };

          const photoMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id,
            reply_to_message_id: message_id,
            text: `Заявка #${row} помечена как "Выполнено".\n\nПожалуйста, отправьте фото выполненных работ.`
          });

          userStates[chat_id].tempMsgs.push(photoMsg.data.result.message_id);
          return res.sendStatus(200);
        }

        // Обновляем статус для других вариантов и показываем меню после "Принято в работу"
        await axios.post(GOOGLE_SCRIPT_URL, { row, response: status, message_id });

        const keyboard = {
          inline_keyboard: [
            statusButtonsAfterAccept.map(btn => ({
              text: btn.text,
              callback_data: `${btn.callback_data}_${row}`
            }))
          ]
        };

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          reply_to_message_id: message_id,
          text: `Статус заявки #${row} обновлён на "${status}". Выберите следующий статус:`,
          reply_markup: JSON.stringify(keyboard)
        });

        return res.sendStatus(200);
      }
    }

    // Обработка сообщений пользователя (в цепочке "Выполнено")
    if (body.message) {
      const chat_id = body.message.chat.id;
      const userState = userStates[chat_id];
      if (!userState) return res.sendStatus(200);

      const text = body.message.text;
      const photo = body.message.photo;
      const message_id = body.message.message_id;

      userState.tempMsgs.push(message_id);

      if (userState.step === "request_photo") {
        if (!photo) {
          const askPhotoAgain = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id,
            reply_to_message_id: message_id,
            text: "Пожалуйста, отправьте фото выполненных работ в виде фотографии."
          });
          userState.tempMsgs.push(askPhotoAgain.data.result.message_id);
          return res.sendStatus(200);
        }
        const photoFileId = photo[photo.length - 1].file_id;
        const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photoFileId}`);
        const filePath = fileInfo.data.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        userState.photoUrl = fileUrl;
        userState.step = "request_sum";

        const askSumMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          reply_to_message_id: message_id,
          text: "Фото получено. Пожалуйста, введите сумму выполненных работ (число)."
        });
        userState.tempMsgs.push(askSumMsg.data.result.message_id);
        return res.sendStatus(200);
      }

      if (userState.step === "request_sum") {
        const sum = parseFloat(text?.replace(/[^\d.,]/g, "").replace(",", "."));
        if (isNaN(sum)) {
          const askSumAgain = await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id,
            reply_to_message_id: message_id,
            text: "Пожалуйста, введите сумму в числовом формате."
          });
          userState.tempMsgs.push(askSumAgain.data.result.message_id);
          return res.sendStatus(200);
        }
        userState.sum = sum;
        userState.step = "request_comment";

        const askCommentMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          reply_to_message_id: message_id,
          text: "Сумма получена. Пожалуйста, введите комментарий к заявке."
        });
        userState.tempMsgs.push(askCommentMsg.data.result.message_id);
        return res.sendStatus(200);
      }

      if (userState.step === "request_comment") {
        userState.comment = text || "";

        await axios.post(GOOGLE_SCRIPT_URL, {
          row: userState.row,
          response: "Выполнено",
          photo: userState.photoUrl,
          sum: userState.sum,
          comment: userState.comment,
          message_id: userState.originalMessageId,
          username: body.message.from.username || body.message.from.first_name,
          executor: body.message.from.username ? `@${body.message.from.username}` : body.message.from.first_name,
        });

        const overdueDays = 1; // тут можно добавить логику вычисления просрочки
        const finalText =
          `Заявка #${userState.row} закрыта.\n` +
          `💰 Сумма: ${userState.sum} сум\n` +
          `👤 Исполнитель: ${userState.executor}\n` +
          `🔴 Просрочка: ${overdueDays} дн.`;

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          reply_to_message_id: userState.originalMessageId,
          text: finalText
        });

        setTimeout(async () => {
          const tempMsgs = userState.tempMsgs || [];
          for (const msgId of tempMsgs) {
            try {
              await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id, message_id: msgId });
            } catch {}
          }
          delete userStates[chat_id];
        }, 60000);

        return res.sendStatus(200);
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Ошибка webhook:", error);
    return res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
