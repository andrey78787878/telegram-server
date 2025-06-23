const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbzZOpnwn8fzbTb0rYyK8HWKV45-Lih7MKGhPtYvn24UXgdPWLQTHxY_1nbSwOwcBH72/exec';
const allowedUsernames = ['Andrey Ткасh', '@Andrey_Tkach_MB', '@Olim19', '@AzzeR133'];

const photoRequests = new Map();
const sumRequests = new Map();
const tempMessages = new Map();
const finalMessageMap = new Map();

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { data: callbackData, message, from, id: callbackId } = body.callback_query;
    const chatId = message.chat.id;
    const msgId = message.message_id;
    const username = from.username ? `@${from.username}` : from.first_name;
    let row, responseText;

    if (!allowedUsernames.includes(username) && /^(accept_|cancel_|done_|working_|waiting_)/.test(callbackData)) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '⛔ У вас нет доступа к этой кнопке',
        show_alert: true
      });
      return res.sendStatus(200);
    }

    if (callbackData.startsWith('accept_')) {
      responseText = 'Принято в работу';
      row = +callbackData.split('_')[1];
    } else if (callbackData.startsWith('cancel_')) {
      responseText = 'Отмена';
      row = +callbackData.split('_')[1];
    } else if (callbackData.startsWith('done_')) {
      responseText = 'Выполнено';
      row = +callbackData.split('_')[1];
      photoRequests.set(chatId, { row, msgId });
      const r = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: '📷 Пожалуйста, отправьте фото как изображение, не как файл.',
        reply_to_message_id: msgId
      });
      tempMessages.set(chatId, [r.data.result.message_id]);
    } else if (callbackData.startsWith('waiting_')) {
      responseText = 'Ожидает поставки комплектующих';
      row = +callbackData.split('_')[1];
    } else if (callbackData.startsWith('working_')) {
      row = +callbackData.split('_')[1];
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Выполнено', callback_data: `done_${row}` },
            { text: '❌ Отменено', callback_data: `cancel_${row}` }
          ],
          [
            { text: '⏳ Ожидает поставки комплектующих', callback_data: `waiting_${row}` }
          ]
        ]
      };
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: JSON.stringify(keyboard)
      });
      return res.sendStatus(200);
    }

    if (responseText && row) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '✅ Выбор зарегистрирован'
      });

      await axios.post(WEB_APP_URL, { row, response: responseText, message_id: msgId });

      let newMarkup = {};
      if (responseText === 'Принято в работу') {
        newMarkup = { inline_keyboard: [[{ text: '🟢 В работе', callback_data: `working_${row}` }]] };
      } else if (responseText === 'Ожидает поставки комплектующих') {
        newMarkup = { inline_keyboard: [[{ text: '⏳ Ожидает поставки комплектующих', callback_data: `working_${row}` }]] };
      }

      if (Object.keys(newMarkup).length) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: msgId,
          reply_markup: JSON.stringify(newMarkup)
        });
      }
    }

    return res.sendStatus(200);
  }

  if (body.message && body.message.photo && photoRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const { row, msgId } = photoRequests.get(chatId);
    const largest = body.message.photo.pop();
    const fileId = largest.file_id;
    const user = body.message.from;
    const username = user.username ? `@${user.username}` : user.first_name;

    const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;

    await axios.post(WEB_APP_URL, { row, response: 'Выполнено', photo: fileUrl, username, message_id: msgId });

    sumRequests.set(chatId, { row, msgId, fileUrl, username });
    photoRequests.delete(chatId);

    const sumReq = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `📩 Фото получено для заявки #${row}. Пожалуйста, введите сумму работ.`
    });
    tempMessages.set(chatId, [sumReq.data.result.message_id]);

    setTimeout(async () => {
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: msgId,
          text: `📌 Заявка #${row} — фото получено.`
        });
      } catch (e) { console.error(e.message); }
    }, 60 * 1000);

    return res.sendStatus(200);
  }

  if (body.message && sumRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const text = body.message.text;
    const { row, msgId, fileUrl, username } = sumRequests.get(chatId);
    const sum = parseInt(text.replace(/\D/g, '')) || 0;

    await axios.post(WEB_APP_URL, { row, sum });

    const final = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Заявка #${row} закрыта.
💰 Сумма: ${sum} сум
👤 Исполнитель: ${username}`,
      reply_to_message_id: msgId
    });

    sumRequests.delete(chatId);

    setTimeout(async () => {
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: msgId,
          text: `📌 Заявка #${row} закрыта.
📎 Фото: ${fileUrl}
💰 Сумма: ${sum} сум
👤 Исполнитель: ${username}
✅ Статус: Выполнено`
        });
      } catch (e) { console.error(e.message); }
    }, 60 * 1000);

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

cron.schedule('0 5 * * *', async () => {
  try {
    await axios.post(WEB_APP_URL, { action: 'checkReminders' });
    console.log('🔔 Напоминания отправлены');
  } catch (err) {
    console.error('Ошибка напоминаний:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
