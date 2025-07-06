// server.js
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
// Telegram шлёт JSON и в callback_query, и в message
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_URL    = 'https://script.google.com/macros/s/AKfycbx-yVE9Z8lWDVNUoLrGbuEfp7hyvHogQfPLc9ehH6afPmAEIlqLSj6r3RuzTK9NmA4W/exec';

const folderId = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ keyFile: 'service_account.json', scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

// список исполнителей
const EXECUTORS = [
  '@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'
];

// храним состояния «выполнено» по chatId
const userState = {};

// утилиты
async function sendMessage(chatId, text, replyMarkup, replyTo) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyTo)     payload.reply_to_message_id = replyTo;
  return axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}
function buildInitialButtons(id) {
  return { inline_keyboard: [[{ text:'Принято в работу', callback_data:`in_progress_${id}` }]] };
}
function buildWorkButtons(id) {
  return { inline_keyboard: [
    [{ text:'✅ Выполнено',         callback_data:`completed_${id}` }],
    [{ text:'🕐 Ожидает поставки',  callback_data:`delayed_${id}` }],
    [{ text:'❌ Отмена',            callback_data:`cancelled_${id}` }]
  ]};
}
async function deleteMessage(chatId, msgId){
  return axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id:chatId, message_id:msgId }).catch(()=>{});
}


// основной webhook
app.post('/', async (req, res) => {
  const body = req.body;
  console.log('🔔 Webhook body:', JSON.stringify(body).slice(0, 200));

  try {
    // === callback_query ===
    if (body.callback_query) {
      const cb       = body.callback_query;
      const data     = cb.data;
      const chatId   = cb.message.chat.id;
      const msgId    = cb.message.message_id;
      const user     = cb.from.username || cb.from.first_name;

      // «Принято в работу»
      if (data.startsWith('in_progress_')) {
        const id = data.split('_')[1];
        // в Google Sheet
        await axios.post(GAS_URL, { message_id:id, status:'В работе', executor:`@${user}` });
        // заменить кнопки на «выполнено/ждёт/отмена»
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id:chatId, message_id:id,
          reply_markup: buildWorkButtons(id)
        });
        // уведомить
        await sendMessage(chatId,
          `👤 Заявка #${id} принята в работу: @${user}`, null, id
        );
        return res.sendStatus(200);
      }

      // «Выполнено»
      if (data.startsWith('completed_')) {
        const id = data.split('_')[1];
        userState[chatId] = { stage:'photo', id, user, temp:[] };
        const m = await sendMessage(chatId,'📸 Пришлите фото выполненной работы.');
        userState[chatId].temp.push(m.data.result.message_id);
        return res.sendStatus(200);
      }

      // «ожидает» / «отмена»
      if (data.startsWith('delayed_')||data.startsWith('cancelled_')) {
        const [act, id] = data.split('_');
        const status = act==='delayed_'?'Ожидает поставки':'Отменено';
        await axios.post(GAS_URL, { message_id:id, status });
        await sendMessage(chatId, `🔄 Заявка #${id}: ${status}`, null, id);
        return res.sendStatus(200);
      }
    }

    // === «Выполнено»: фото / сумма / коммент ===
    if (body.message && userState[body.message.chat.id]) {
      const st = userState[body.message.chat.id];
      const chatId = body.message.chat.id;

      // фото
      if (st.stage==='photo' && body.message.photo) {
        const fileId = body.message.photo.slice(-1)[0].file_id;
        const fInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const stream = (await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fInfo.data.result.file_path}`,{responseType:'stream'})).data;
        // загружаем в Drive
        const up = await drive.files.create({
          resource:{ name:`done_${st.id}.jpg`, parents:[folderId] },
          media:{ mimeType:'image/jpeg', body:stream },
          fields:'id'
        });
        await drive.permissions.create({fileId:up.data.id,requestBody:{role:'reader',type:'anyone'}});
        st.photo = `https://drive.google.com/uc?id=${up.data.id}`;

        st.stage = 'sum';
        st.temp.push(body.message.message_id);
        const m = await sendMessage(chatId,'💰 Укажите сумму (только цифры):');
        st.temp.push(m.data.result.message_id);
        return res.sendStatus(200);
      }

      // сумма
      if (st.stage==='sum' && body.message.text) {
        st.sum = body.message.text.replace(/[^\d]/g,'');
        st.stage='comment';
        st.temp.push(body.message.message_id);
        const m = await sendMessage(chatId,'📝 Теперь введите комментарий:');
        st.temp.push(m.data.result.message_id);
        return res.sendStatus(200);
      }

      // комментарий
      if (st.stage==='comment' && body.message.text) {
        const comment = body.message.text;
        st.temp.push(body.message.message_id);
        // пишем всё в Google
        await axios.post(GAS_URL,{
          message_id:st.id,
          photo:st.photo,
          sum:st.sum,
          comment,
          executor:`@${st.user}`
        });
        // редактируем исходное сообщение
        await axios.post(`${TELEGRAM_API}/editMessageText`,{
          chat_id:chatId,
          message_id:st.id,
          text:
            `📌 Заявка #${st.id} закрыта.\n`+
            `📎 Фото: <a href="${st.photo}">ссылка</a>\n`+
            `💰 Сумма: ${st.sum} сум\n`+
            `👤 Исполнитель: @${st.user}\n`+
            `✅ Статус: Выполнено`,
          parse_mode:'HTML'
        });
        // чистим временные сообщения через минуту
        setTimeout(()=>st.temp.forEach(mid=>deleteMessage(chatId,mid)),60_000);
        delete userState[chatId];
        return res.sendStatus(200);
      }
    }

    // если ни одно условие не спрацювало
    res.sendStatus(200);
  }
  catch(err){
    console.error('❌ WEBHOOK ERROR:',err.stack||err);
    res.sendStatus(500);
  }
});

// порт из Render
const PORT = process.env.PORT;
if (!PORT) throw new Error('PORT must be defined');
app.listen(PORT,()=>console.log(`✅ Server listening on ${PORT}`));
