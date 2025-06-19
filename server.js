const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL   = 'https://script.google.com/macros/s/AKfycbyn3vj1h2RnCMG0RLiKe-Qzr2p5t4rhiyVrzsZalRA-72F_vtqBm-eLkFHjVqUmGiir/exec';

const allowedUsernames = ['Andrey Ткасh', '@Andrey_Tkach_MB', '@Olim19', '@AzzeR133'];

// Временные состояния между шагами ("фото→сумма")
const photoRequests     = new Map();
const sumRequests       = new Map();
const tempMessages      = new Map();
const finalMessageMap   = new Map();

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const body = req.body;

  // 1) Обработка нажатий inline-кнопок
  if (body.callback_query) {
    const { data: callbackData, message, from, id: callbackId } = body.callback_query;
    const chatId    = message.chat.id;
    const msgId     = message.message_id;
    const username  = from.username ? `@${from.username}` : from.first_name;
    let   row, responseText;

    // Проверка прав
    if (!allowedUsernames.includes(username) &&
        /^(accept_|cancel_|done_|working_|waiting_)/.test(callbackData)) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '⛔ У вас нет доступа к этой кнопке',
        show_alert: true
      });
      return res.sendStatus(200);
    }

    // Определяем действие и номер строки
    if (callbackData.startsWith('accept_')) {
      responseText = 'Принято в работу';
      row = +callbackData.split('_')[1];
    }
    else if (callbackData.startsWith('cancel_')) {
      responseText = 'Отмена';
      row = +callbackData.split('_')[1];
    }
    else if (callbackData.startsWith('done_')) {
      responseText = 'Выполнено';
      row = +callbackData.split('_')[1];
      // Запрос фото
      photoRequests.set(chatId, { row, msgId });
      const r = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: '📷 Пожалуйста, отправьте фото как изображение, не как файл.',
        reply_to_message_id: msgId
      });
      tempMessages.set(chatId, [ r.data.result.message_id ]);
    }
    else if (callbackData.startsWith('waiting_')) {
      responseText = 'Ожидает поставки комплектующих';
      row = +callbackData.split('_')[1];
    }
    else if (callbackData.startsWith('working_')) {
      row = +callbackData.split('_')[1];
      // Показать исходные кнопки заново
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

    // Ответ на нажатие
    if (responseText && row) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        text: '✅ Выбор зарегистрирован'
      });
      // Запись в Google Apps Script
      await axios.post(WEB_APP_URL, { row, response: responseText });

      // Обновление самой кнопки
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

  // 2) Приём фотографии после "Выполнено"
  if (body.message && body.message.photo && photoRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const { row, msgId } = photoRequests.get(chatId);
    const largest = body.message.photo.pop();
    const fileId  = largest.file_id;
    const user    = body.message.from;
    const username= user.username ? `@${user.username}` : user.first_name;

    // Получаем прямую ссылку 
    const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;

    // Запись статуса, фото, исполнителя
    await axios.post(WEB_APP_URL, { row, response:'Выполнено', photo:fileUrl, username });

    // Перехват ввода суммы
    sumRequests.set(chatId, { row, msgId, fileUrl, username });
    photoRequests.delete(chatId);

    // Просим сумму
    const sumReq = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `📩 Фото получено для заявки #${row}. Пожалуйста, введите сумму работ (например, 230000).`
    });
    tempMessages.set(chatId, [ sumReq.data.result.message_id ]);

    // Удалим исходное фото-уведомление и подсветим карточку
    setTimeout(async ()=>{
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id: chatId, message_id: msgId
        });
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: msgId,
          text: `📌 Статус: Выполнено\n📎 Фото: ${fileUrl}`
        });
      } catch(e){ console.error(e.message); }
    }, 60000);

    return res.sendStatus(200);
  }

  // 3) Приём суммы от исполнителя
  if (body.message && sumRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const text   = body.message.text;
    const { row, msgId, fileUrl, username } = sumRequests.get(chatId);
    const sum    = parseInt(text.replace(/\D/g,''))||0;

    // Запись суммы
    await axios.post(WEB_APP_URL, { row, sum });

    // Финальное сообщение
    const final = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Заявка #${row} закрыта.\n💰 Сумма работ: ${sum} сум\n👤 Исполнитель: ${username}`,
      reply_to_message_id: msgId
    });
    const finalId = final.data.result.message_id;

    // Удаляем промежуточные запросы и итог через 15 мин
    const temps = tempMessages.get(chatId)||[];
    for(const id of temps){
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
        chat_id, message_id:id
      }).catch(()=>{/*ignored*/});
    }
    tempMessages.delete(chatId);

    finalMessageMap.set(chatId,{ finalId, row, fileUrl, sum, username, msgId });
    sumRequests.delete(chatId);

    setTimeout(async ()=>{
      try {
        const data = finalMessageMap.get(chatId);
        if(!data) return;
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id, message_id:data.finalId
        });
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
          chat_id, message_id:data.msgId,
          text: `📌 Заявка #${data.row} закрыта.\n📎 Фото: ${data.fileUrl}\n💰 Сумма: ${data.sum} сум\n👤 Исполнитель: ${data.username}\n✅ Статус: Выполнено`
        });
      } catch(e){ console.error(e.message); }
    }, 15*60*1000);

    return res.sendStatus(200);
  }

  // Всегда отвечаем 200
  res.sendStatus(200);
});

// Напоминания: 5:00 UTC = 10:00 UZT
cron.schedule('0 5 * * *', async () => {
  try {
    await axios.post(WEB_APP_URL, { action:'checkReminders' });
    console.log('🔔 Утренние напоминания отправлены');
  } catch(err){
    console.error('Ошибка напоминаний:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
