const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyn3vj1h2RnCMG0RLiKe-Qzr2p5t4rhiyVrzsZalRA-72F_vtqBm-eLkFHjVqUmGiir/exec';

const allowedUsernames = ['Andrey Ткасh', '@Andrey_Tkach_MB'];
const photoRequests = new Map();

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.callback_query) {
    const { data: callbackData, message, from, id: callbackId } = body.callback_query;
    const messageId = message.message_id;
    const chatId = message.chat.id;
    const username = from.username ? `@${from.username}` : from.first_name;

    let responseText = '';
    let row = null;

    const protectedActions = ['accept_', 'cancel_', 'done_', 'working_', 'waiting_'];
    const needsProtection = protectedActions.some(action => callbackData.startsWith(action));

    if (needsProtection && !allowedUsernames.includes(username)) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '⛔ У вас нет доступа к этой кнопке',
        show_alert: true
      });
      return res.sendStatus(200);
    }

    if (callbackData.startsWith('accept_')) {
      responseText = 'Принято в работу';
      row = parseInt(callbackData.split('_')[1], 10);
    } else if (callbackData.startsWith('cancel_')) {
      responseText = 'Отмена';
      row = parseInt(callbackData.split('_')[1], 10);
    } else if (callbackData.startsWith('done_')) {
      responseText = 'Выполнено';
      row = parseInt(callbackData.split('_')[1], 10);

      // Запрос фото
      photoRequests.set(chatId, { row, messageId });
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: '📷 Пожалуйста, отправьте фото как изображение, не как файл.'
      });
    } else if (callbackData.startsWith('waiting_')) {
      responseText = 'Ожидает поставки комплектующих';
      row = parseInt(callbackData.split('_')[1], 10);
    } else if (callbackData.startsWith('working_')) {
      row = parseInt(callbackData.split('_')[1], 10);
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
        message_id: messageId,
        reply_markup: JSON.stringify(keyboard)
      });
      return res.sendStatus(200);
    }

    if (responseText && row) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '✅ Выбор зарегистрирован'
      });

      await axios.post(WEB_APP_URL, { row, response: responseText });

      let newMarkup = {};
      if (responseText === 'Принято в работу') {
        newMarkup = { inline_keyboard: [[{ text: '🟢 В работе', callback_data: `working_${row}` }]] };
      } else if (responseText === 'Ожидает поставки комплектующих') {
        newMarkup = { inline_keyboard: [[{ text: '⏳ Ожидает поставки комплектующих', callback_data: `working_${row}` }]] };
      }

      if (Object.keys(newMarkup).length) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: JSON.stringify(newMarkup)
        });
      }
    }

    return res.sendStatus(200);
  }

  if (body.message && body.message.photo && photoRequests.has(body.message.chat.id)) {
    const { chat: { id: chatId }, photo, message_id } = body.message;
    const largestPhoto = photo[photo.length - 1];
    const fileId = largestPhoto.file_id;
    const { row, messageId } = photoRequests.get(chatId);

    try {
      const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

      await axios.post(WEB_APP_URL, {
        row,
        response: 'Выполнено',
        photo: fileUrl
      });

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: '✅ Фото получено и заявка закрыта.'
      });

      photoRequests.delete(chatId);
    } catch (err) {
      console.error('Ошибка при обработке фото:', err.message);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
