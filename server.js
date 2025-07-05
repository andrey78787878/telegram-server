const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = https://api.telegram.org/bot${BOT_TOKEN};
const TELEGRAM_FILE_API = https://api.telegram.org/file/bot${BOT_TOKEN};
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxeXikOhZy-HlXNTh4Dpz7FWqBf1pRi6DWpzGQlFQr8TSV46KUU_-FJF976oQrxpHAx/exec';

app.use(express.json());

// Хранилище временных данных по пользователям
const userStates = {};

app.post('/webhook', async (req, res) => {
  const message = req.body.message || req.body.edited_message;
  const callbackQuery = req.body.callback_query;

  if (callbackQuery) {
    handleCallbackQuery(callbackQuery);
    return res.sendStatus(200);
  }

  if (message) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const text = message.text;
    const photo = message.photo;

    if (userStates[userId]?.waitingFor === 'photo' && photo) {
      const fileId = photo[photo.length - 1].file_id;
      const fileUrl = await getFileLink(fileId);
      userStates[userId].photo = fileUrl;
      userStates[userId].waitingFor = 'sum';
      await sendMessage(chatId, 'Укажите сумму 💰');
      return res.sendStatus(200);
    }

    if (userStates[userId]?.waitingFor === 'sum' && text) {
      userStates[userId].sum = text;
      userStates[userId].waitingFor = 'comment';
      await sendMessage(chatId, 'Оставьте комментарий 📝');
      return res.sendStatus(200);
    }

    if (userStates[userId]?.waitingFor === 'comment' && text) {
      userStates[userId].comment = text;

      const {
        row,
        message_id,
        photo,
        sum,
        comment,
        username,
        problem,
        overdueDays,
      } = userStates[userId];

      await axios.post(GAS_URL, {
        action: 'close_request',
        row,
        photo,
        sum,
        comment,
        username,
      });

      const textFinal = 
📌 Заявка #${row} закрыта.
📎 Фото: [ссылка](${photo})
💰 Сумма: ${sum} сум
👤 Исполнитель: @${username}
✅ Статус: Выполнено
🛠️ ${problem}
💬 ${comment}
🔴 Просрочка: ${overdueDays} дн.
      .trim();

      await editMessage(userStates[userId].chat_id, message_id, textFinal);

      delete userStates[userId];

      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

async function handleCallbackQuery(query) {
  const data = query.data;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const username = query.from.username || query.from.first_name;
  const row = extractRowFromText(query.message.text);
  const problem = extractProblemFromText(query.message.text);

  if (data === 'done') {
    const overdueDays = extractOverdueFromText(query.message.text);

    userStates[query.from.id] = {
      waitingFor: 'photo',
      row,
      message_id: messageId,
      chat_id: chatId,
      username,
      problem,
      overdueDays,
    };

    await sendMessage(chatId, 'Загрузите фото выполненных работ 📷');
  }
}

async function sendMessage(chatId, text) {
  await axios.post(${TELEGRAM_API}/sendMessage, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  });
}

async function editMessage(chatId, messageId, newText) {
  await axios.post(${TELEGRAM_API}/editMessageText, {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

async function getFileLink(fileId) {
  const res = await axios.get(${TELEGRAM_API}/getFile?file_id=${fileId});
  const filePath = res.data.result.file_path;
  return ${TELEGRAM_FILE_API}/${filePath};
}

function extractRowFromText(text) {
  const match = text.match(/Заявка\s+#(\d+)/);
  return match ? match[1] : '';
}

function extractOverdueFromText(text) {
  const match = text.match(/Просрочка: (\d+)/);
  return match ? match[1] : '0';
}

function extractProblemFromText(text) {
  const match = text.match(/Суть проблемы:\s*(.+?)\n/i);
  return match ? match[1].trim() : '';
}

app.listen(PORT, () => {
  console.log(Server is running on port ${PORT});
});
