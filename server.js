const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const WEB_APP_URL   = 'https://script.google.com/macros/s/AKfycbyn3vj1h2RnCMG0RLiKe-Qzr2p5t4rhiyVrzsZalRA-72F_vtqBm-eLkFHjVqUmGiir/exec';

const allowedUsernames = ['Andrey Ткасh', '@Andrey_Tkach_MB', '@Olim19', '@AzzeR133'];

const photoRequests     = new Map();
const sumRequests       = new Map();
const tempMessages      = new Map();
const finalMessageMap   = new Map();

app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.message && body.message.photo && photoRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const { row, msgId } = photoRequests.get(chatId);
    const largest = body.message.photo.pop();
    const fileId  = largest.file_id;
    const user    = body.message.from;
    const username= user.username ? `@${user.username}` : user.first_name;

    const fileRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileRes.data.result.file_path}`;

    await axios.post(WEB_APP_URL, { row, response:'Выполнено', photo:fileUrl, username });

    sumRequests.set(chatId, { row, msgId, fileUrl, username });
    photoRequests.delete(chatId);

    const sumReq = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `📩 Фото получено для заявки #${row}. Пожалуйста, введите сумму работ (например, 230000).`
    });
    tempMessages.set(chatId, [ sumReq.data.result.message_id ]);

    setTimeout(async ()=>{
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: msgId,
          text: `📌 Заявка #${row} (обновлена):\n📎 Фото: ${fileUrl}\n✅ Статус: Выполнено`
        });
      } catch(e){ console.error(e.message); }
    }, 60000);

    return res.sendStatus(200);
  }

  if (body.message && sumRequests.has(body.message.chat.id)) {
    const chatId = body.message.chat.id;
    const text   = body.message.text;
    const { row, msgId, fileUrl, username } = sumRequests.get(chatId);
    const sum    = parseInt(text.replace(/\D/g,''))||0;

    await axios.post(WEB_APP_URL, { row, sum });

    const final = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `✅ Заявка #${row} закрыта.\n💰 Сумма работ: ${sum} сум\n👤 Исполнитель: ${username}`,
      reply_to_message_id: msgId
    });
    const finalId = final.data.result.message_id;

    const temps = tempMessages.get(chatId)||[];
    for(const id of temps){
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`, {
        chat_id, message_id:id
      }).catch(()=>{/* ignored */});
    }
    tempMessages.delete(chatId);

    finalMessageMap.set(chatId,{ finalId, row, fileUrl, sum, username, msgId });
    sumRequests.delete(chatId);

    setTimeout(async ()=>{
      try {
        const data = finalMessageMap.get(chatId);
        if(!data) return;
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
          chat_id, message_id:data.finalId,
          text: `📌 Заявка #${data.row} закрыта.\n📎 Фото: ${data.fileUrl}\n💰 Сумма: ${data.sum} сум\n👤 Исполнитель: ${data.username}\n✅ Статус: Выполнено`
        });

        // Обновим колонку Q с message_id в Google Sheet
        await axios.post(WEB_APP_URL, {
          row: data.row,
          message_id: data.finalId
        });
      } catch(e){ console.error(e.message); }
    }, 60000);

    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
