const express = require('express');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const userState = {}; // chatId -> { stage, row, username, messageId }

const buildInitialButtons = (messageId, row) => ({
  inline_keyboard: [
    [
      {
        text: 'Принято в работу 🟢',
        callback_data: JSON.stringify({ action: 'in_progress', messageId, row })
      }
    ]
  ]
});

const buildFollowUpButtons = (row) => ({
  inline_keyboard: [
    [
      {
        text: 'Выполнено ✅',
        callback_data: JSON.stringify({ action: 'completed', row })
      },
      {
        text: 'Ожидает поставки 🕐',
        callback_data: JSON.stringify({ action: 'delayed', row })
      },
      {
        text: 'Отмена ❌',
        callback_data: JSON.stringify({ action: 'cancelled', row })
      }
    ]
  ]
});

const sendMessage = async (chatId, text, options = {}) => {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      ...options
    });
  } catch (err) {
    console.error('Ошибка отправки сообщения:', err.response?.data || err.message);
  }
};

const editMessageText = async (chatId, messageId, text, reply_markup) => {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup
    });
  } catch (err) {
    console.error('Ошибка редактирования сообщения:', err.response?.data || err.message);
  }
};

const deleteMessage = async (chatId, messageId) => {
  try {
    await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
  } catch (err) {
    console.error('Ошибка удаления сообщения:', err.response?.data || err.message);
  }
};

const askForPhoto = async (chatId) => {
  await sendMessage(chatId, 'Пожалуйста, пришлите фото выполненных работ.');
};

const askForSum = async (chatId) => {
  await sendMessage(chatId, 'Введите сумму работ в сумах:');
};

const askForComment = async (chatId) => {
  await sendMessage(chatId, 'Добавьте комментарий:');
};

const uploadPhotoToDrive = require('./utils/driveUploader');
const sendToSpreadsheet = require('./utils/spreadsheet');

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // --- Ответ на текстовые сообщения
  if (body.message) {
    const chatId = body.message.chat.id;

    // Если есть фото
    if (body.message.photo && userState[chatId]?.stage === 'photo') {
      const fileId = body.message.photo.at(-1).file_id;
      const row = userState[chatId].row;
      const username = userState[chatId].username;
      const messageId = userState[chatId].messageId;

      try {
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
        const fileName = `photo_${Date.now()}.jpg`;

        const photoLink = await uploadPhotoToDrive(fileUrl, fileName);

        userState[chatId].photo = photoLink;
        userState[chatId].stage = 'sum';

        await askForSum(chatId);
      } catch (err) {
        console.error('Ошибка при загрузке фото:', err.message);
        await sendMessage(chatId, 'Ошибка загрузки фото. Попробуйте снова.');
      }

      return res.sendStatus(200);
    }

    // Если это сумма
    if (userState[chatId]?.stage === 'sum') {
      const sum = body.message.text;
      userState[chatId].sum = sum;
      userState[chatId].stage = 'comment';

      await askForComment(chatId);
      return res.sendStatus(200);
    }

    // Если это комментарий
    if (userState[chatId]?.stage === 'comment') {
      const comment = body.message.text;
      const { row, photo, sum, username, messageId } = userState[chatId];

      try {
        await axios.post(GAS_WEB_APP_URL, {
          row,
          photo,
          sum,
          comment,
          username,
          message_id: messageId
        });

        await sendMessage(chatId, `Заявка #${row} закрыта. 💰 Сумма: ${sum} сум 👤 Исполнитель: ${username}`);

        delete userState[chatId];
      } catch (err) {
        console.error('Ошибка отправки данных в таблицу:', err.message);
        await sendMessage(chatId, 'Ошибка сохранения данных. Попробуйте позже.');
      }

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  }

  // --- Ответ на кнопки
  if (body.callback_query) {
    const callbackData = body.callback_query.data;
    const chatId = body.callback_query.message.chat.id;
    const messageId = body.callback_query.message.message_id;
    const username = '@' + body.callback_query.from.username;

    let parsed;
    try {
      parsed = JSON.parse(callbackData);
    } catch {
      console.error('⚠️ Некорректный callback_data:', callbackData);
      return res.sendStatus(200);
    }

    const { action, row, messageId: originalMessageId } = parsed;

    if (!action || !row) {
      console.error('⚠️ Отсутствуют обязательные поля');
      return res.sendStatus(200);
    }

    if (action === 'in_progress') {
      await axios.post(GAS_WEB_APP_URL, {
        data: 'start',
        row,
        username,
        message_id: originalMessageId
      });

      await editMessageText(
        chatId,
        messageId,
        `🟢 Заявка #${row} в работе.\n👤 Исполнитель: ${username}`,
        buildFollowUpButtons(row)
      );
    }

    if (action === 'completed') {
      userState[chatId] = { stage: 'photo', row, username, messageId };
      await askForPhoto(chatId);
    }

    if (action === 'delayed' || action === 'cancelled') {
      await axios.post(GAS_WEB_APP_URL, {
        data: action,
        row,
        username,
        message_id: originalMessageId
      });

      await editMessageText(
        chatId,
        messageId,
        `📌 Заявка #${row}\n⚠️ Статус: ${action === 'delayed' ? 'Ожидает поставки' : 'Отменена'}\n👤 Исполнитель: ${username}`
      );
    }

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
