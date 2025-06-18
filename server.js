const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyn3vj1h2RnCMG0RLiKe-Qzr2p5t4rhiyVrzsZalRA-72F_vtqBm-eLkFHjVqUmGiir/exec';

const allowedUsernames = ['Andrey Ткасh', '@Andrey_Tkach_MB', '@Olim19', '@AzzeR133'];
const photoRequests = new Map();
const sumRequests = new Map();
const photoMessageMap = new Map();
const finalMessageMap = new Map();

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
      photoRequests.set(chatId, { row, messageId });
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: '📷 Пожалуйста, отправьте фото как изображение, не как файл.',
        reply_to_message_id: messageId
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
    const { chat: { id: chatId }, photo, from, message_id: photoMessageId } = body.message;
    const largestPhoto = photo[photo.length - 1];
    const fileId = largestPhoto.file_id;
    const { row, messageId } = photoRequests.get(chatId);
    const username = from.username ? `@${from.username}` : from.first_name;

    try {
      const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

      await axios.post(WEB_APP_URL, {
        row,
        response: 'Выполнено',
        photo: fileUrl,
        username: username
      });

      sumRequests.set(chatId, { row, messageId, fileUrl, executor: username });
      photoRequests.delete(chatId);
      photoMessageMap.set(chatId, photoMessageId);

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: `📩 Фото получено для заявки #${row}. Пожалуйста, введите сумму работ в сообщении (например, 230000).`
      });

      setTimeout(async () => {
        try {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
            chat_id: chatId,
            message_id: photoMessageId
          });

          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: `📌 Статус: Выполнено\n📎 Фото по заявке: ${fileUrl}`
          });
        } catch (err) {
          console.error('Ошибка удаления/обновления сообщения:', err.message);
        }
      }, 60000);

    } catch (err) {
      console.error('Ошибка при обработке фото:', err.message);
    }
  } else if (body.message && sumRequests.has(body.message.chat.id)) {
    const { chat: { id: chatId }, text, from, message_id: sumMsgId } = body.message;
    const { row, messageId, fileUrl, executor } = sumRequests.get(chatId);
    const sum = parseInt(text.replace(/\D/g, '')) || 0;

    await axios.post(WEB_APP_URL, { row, sum });

    const finalMsg = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Заявка #${row} закрыта.\n💰 Сумма работ: ${sum} сум\n👤 Исполнитель: ${executor}`,
      reply_to_message_id: messageId
    });

    const finalMsgId = finalMsg.data.result.message_id;
    finalMessageMap.set(chatId, { finalMsgId, row, sum, fileUrl, executor, messageId });
    sumRequests.delete(chatId);

    setTimeout(async () => {
      try {
        const data = finalMessageMap.get(chatId);
        if (!data) return;

        const { finalMsgId, row, sum, fileUrl, executor, messageId } = data;

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id: chatId,
          message_id: finalMsgId
        });

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: `📌 Заявка #${row} закрыта.\n📎 Фото: ${fileUrl}\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${executor}\n✅ Статус: Выполнено`
        });

        finalMessageMap.delete(chatId);
      } catch (err) {
        console.error('Ошибка при удалении финального сообщения:', err.message);
      }
    }, 15 * 60 * 1000);
  }

  res.sendStatus(200);
});

cron.schedule('0 9 * * *', async () => {
  try {
    await axios.post(WEB_APP_URL, { action: 'checkReminders' });
    console.log('🔔 Утренние напоминания отправлены');
  } catch (err) {
    console.error('Ошибка при отправке напоминаний:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
