app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    // === 1. Обработка нажатий на кнопки (callback_query)
    if (body.callback_query) {
      console.log('➡️ Получен callback_query:', body.callback_query);

      const dataRaw = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + (body.callback_query.from.username || body.callback_query.from.first_name);

      // --- Если кнопка: выбор исполнителя
      if (dataRaw.startsWith('select_executor:')) {
        const parts = dataRaw.split(':');
        const row = parts[1];
        const executor = parts[2];

        if (!row || !executor) {
          console.warn("⚠️ Неверный формат select_executor:", dataRaw);
          return res.sendStatus(200);
        }

        console.log(`👤 Выбран исполнитель ${executor} для заявки #${row}`);

        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'markInProgress',
            row,
            executor
          }
        });

        await editMessageText(
          chatId,
          messageId,
          `🟢 Заявка #${row} в работе.\n👤 Исполнитель: ${executor}`,
          buildFollowUpButtons(row)
        );

        return res.sendStatus(200);
      }

      // --- Все остальные кнопки (выполнено, отмена, задержка)
      let data;
      try {
        data = JSON.parse(dataRaw);
      } catch (e) {
        console.warn("⚠️ Невалидный JSON в callback_data:", dataRaw);
        return res.sendStatus(200);
      }

      const { action, row, messageId: originalMessageId } = data;

      if (action === 'in_progress' && row) {
        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'markInProgress',
            row,
            executor: username
          }
        });

        await editMessageText(
          chatId,
          messageId,
          `🟢 Заявка #${row} в работе.\n👤 Исполнитель: ${username}`,
          buildFollowUpButtons(row)
        );

        return res.sendStatus(200);
      }

      if (action === 'completed' && row) {
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username };
        console.log(`📸 Ожидается фото от ${username} для заявки #${row}`);
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      if ((action === 'delayed' || action === 'cancelled') && row) {
        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action,
            row,
            executor: username
          }
        });

        await editMessageText(
          chatId,
          messageId,
          `📌 Заявка #${row}\n⚠️ Статус: ${action === 'delayed' ? 'Ожидает поставки' : 'Отменена'}\n👤 Исполнитель: ${username}`
        );

        return res.sendStatus(200);
      }
    }

  // Telegram Bot Server Logic (Complete Flow)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

const userStates = {};

// === HANDLERS === //
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.callback_query) return handleCallbackQuery(body.callback_query, res);
  if (body.message) return handleMessage(body.message, res);

  res.sendStatus(200);
});

async function handleCallbackQuery(query, res) {
  const { id, data, message, from } = query;
  const [action, row, executor] = data.split(':');
  const chat_id = message.chat.id;
  const message_id = message.message_id;

  if (action === 'select_executor') {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: id });

    // Обновим материнское сообщение с исполнителем и статусом
    const newText = `${message.text}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id,
      message_id,
      text: newText,
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '✅ Выполнено', callback_data: `done:${row}:${executor}` }],
          [{ text: '🕗 Ожидает поставки', callback_data: `wait:${row}:${executor}` }],
          [{ text: '❌ Отмена', callback_data: `cancel:${row}:${executor}` }]
        ]
      })
    });

    await axios.post(GAS_WEB_APP_URL, {
      message_id,
      row,
      status: 'В работе',
      executor
    });
  }

  if (action === 'done') {
    userStates[from.id] = { step: 'awaiting_photo', row, executor, message_id, chat_id, master_message_id: message_id };
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      reply_to_message_id: message_id,
      text: '📸 Пожалуйста, отправьте фото выполненных работ'
    });
  }

  res.sendStatus(200);
}

async function handleMessage(msg, res) {
  const { text, photo, chat, from, message_id } = msg;
  const userState = userStates[from.id];

  if (!userState) return res.sendStatus(200);

  const { step, row, executor, master_message_id } = userState;

  if (step === 'awaiting_photo' && photo) {
    const file_id = photo[photo.length - 1].file_id;
    const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
    const filePath = fileRes.data.result.file_path;
    const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

    userStates[from.id].step = 'awaiting_sum';
    userStates[from.id].photo = fileUrl;

    await axios.post(GAS_WEB_APP_URL, {
      row,
      photo: fileUrl
    });

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chat.id,
      text: '💰 Укажите сумму выполненных работ (в сумах)'
    });
  }

  else if (step === 'awaiting_sum' && text) {
    userStates[from.id].step = 'awaiting_comment';
    userStates[from.id].sum = text;

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chat.id,
      text: '📝 Добавьте комментарий к заявке'
    });
  }

  else if (step === 'awaiting_comment' && text) {
    const { photo, sum } = userStates[from.id];
    const comment = text;

    await axios.post(GAS_WEB_APP_URL, {
      row,
      status: 'Выполнено',
      sum,
      comment,
      executor
    });

    // Получаем актуальные данные из таблицы (просрочка и Google Drive ссылка)
    const response = await axios.post(`${GAS_WEB_APP_URL}?get=final`, { row });
    const { delay, googlePhoto } = response.data;

    const finalText = `📍 Заявка #${row} ✅ Статус: Выполнено\n\n📋 Проблема: ...\n📝 Комментарий: ${comment}\n\n🍕 Пиццерия: ...\n🔧 Классификация: ...\n📂 Категория: ...\n👤 Инициатор: ...\n📞 Тел: ...\n🕓 Просрочка: ${delay} дн.\n📎 Фото: ${googlePhoto}\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${executor}`;

    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chat.id,
      message_id: master_message_id,
      text: finalText,
      parse_mode: 'HTML'
    });

    await deleteMessages(chat.id, [message_id]);
    delete userStates[from.id];
  }

  res.sendStatus(200);
}

async function deleteMessages(chat_id, ids) {
  for (const id of ids) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id, message_id: id });
    } catch (e) {}
  }
}

// === START SERVER === //
app.listen(PORT, () => {
  console.log('Bot server is running on port', PORT);
});
