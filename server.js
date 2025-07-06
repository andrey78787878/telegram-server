const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// ========== Настройки ==========
const BOT_TOKEN     = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API  = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_URL       = 'https://script.google.com/macros/s/AKfycbx-yVE9Z8lWDVNUoLrGbuEfp7hyvHogQfPLc9ehH6afPmAEIlqLSj6r3RuzTK9NmA4W/exec';
const FOLDER_ID     = '1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF';

// Google Drive авторизация
const auth  = new google.auth.GoogleAuth({ keyFile: 'service_account.json', scopes: ['https://www.googleapis.com/auth/drive'] });
const drive = google.drive({ version: 'v3', auth });

// Список исполнителей (для старого формата)
const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];

// Состояния "выполнено": ждем фото→сумму→коммент
const userState = {};

// ========== Утилиты ==========
async function sendMessage(chatId, text, replyMarkup, replyTo) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyTo)     payload.reply_to_message_id = replyTo;
  return axios.post(`${TELEGRAM_API}/sendMessage`, payload);
}
async function deleteMessage(chatId, messageId) {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: messageId }).catch(()=>{});
}
function buildInitialButtons(id) {
  return { inline_keyboard:[[{ text:'Принято в работу', callback_data:`in_progress_${id}` }]] };
}
function buildWorkButtons(id) {
  return { inline_keyboard:[
    [{ text:'✅ Выполнено',        callback_data:`completed_${id}` }],
    [{ text:'🕐 Ожидает поставки', callback_data:`delayed_${id}`  }],
    [{ text:'❌ Отмена',           callback_data:`cancelled_${id}` }]
  ]};
}
async function uploadPhotoToDrive(stream, name) {
  const file = await drive.files.create({
    resource:{ name, parents:[FOLDER_ID] },
    media:{ mimeType:'image/jpeg', body: stream },
    fields:'id'
  });
  await drive.permissions.create({ fileId:file.data.id, requestBody:{ role:'reader', type:'anyone' }});
  return `https://drive.google.com/uc?id=${file.data.id}`;
}

// ========== Webhook ==========
app.post('/', async (req, res) => {
  const body = req.body;
  console.log('🔔 Webhook body:', JSON.stringify(body).slice(0,200));

  try {
    // --- callback_query ---
    if (body.callback_query) {
      const cb     = body.callback_query;
      const data   = cb.data;
      const chatId = cb.message.chat.id;
      const user   = cb.from.username || cb.from.first_name;

      // 1) Принято в работу
      if (data.startsWith('in_progress_')) {
        const id = data.split('_')[1];
        await axios.post(GAS_URL, { message_id:id, status:'В работе', executor:`@${user}` });
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id:chatId, message_id:id, reply_markup: buildWorkButtons(id)
        });
        await sendMessage(chatId, `👤 Заявка #${id} принята в работу: @${user}`, null, id);
        return res.sendStatus(200);
      }

      // 2) Выполнено → запускаем фотозагрузку
      if (data.startsWith('completed_')) {
        const id = data.split('_')[1];
        userState[chatId] = { stage:'photo', id, user, temp:[] };
        const m = await sendMessage(chatId,'📸 Пришлите фото выполненной работы.');
        userState[chatId].temp.push(m.data.result.message_id);
        return res.sendStatus(200);
      }

      // 3) Ожидает поставки / Отмена
      if (data.startsWith('delayed_')||data.startsWith('cancelled_')) {
        const [act,id] = data.split('_');
        const status = act==='delayed'?'Ожидает поставки':'Отменено';
        await axios.post(GAS_URL, { message_id:id, status });
        await sendMessage(chatId, `🔄 Заявка #${id}: ${status}`, null, id);
        return res.sendStatus(200);
      }

      // --- Старый формат (выбор из списка исполнителей) ---
      if (data.startsWith('start_work_')) {
        const row = data.split('_')[2];
        const buttons = EXECUTORS.map(exec=>[{ text:exec, callback_data:`executor_${exec}_${row}_${cb.message.message_id}` }]);
        const m = await sendMessage(chatId,'Выберите исполнителя',{ inline_keyboard:buttons });
        setTimeout(()=>deleteMessage(chatId,m.data.result.message_id),60000);
        return res.sendStatus(200);
      }
      if (data.startsWith('executor_')) {
        const [_,exec,row,pId] = data.split('_');
        await axios.post(GAS_URL,{ row, executor:exec, message_id:pId, status:'В работе' });
        await deleteMessage(chatId,cb.message.message_id);
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id:chatId,
          message_id:Number(pId),
          text:`🟢 <b>Заявка в работе</b>\n👤 Исполнитель: ${exec}`,
          parse_mode:'HTML',
          reply_markup:buildWorkButtons(pId)
        });
        return res.sendStatus(200);
      }
    }

    // --- Этапы "выполнено" по body.message ---
    if (body.message && userState[body.message.chat.id]) {
      const st     = userState[body.message.chat.id];
      const chatId = body.message.chat.id;

      // а) Фото
      if (st.stage==='photo' && body.message.photo) {
        const fileId = body.message.photo.slice(-1)[0].file_id;
        const finfo  = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const stream = (await axios.get(`${TELEGRAM_FILE_API}/${finfo.data.result.file_path}`,{responseType:'stream'})).data;
        st.photo = await uploadPhotoToDrive(stream,`done_${st.id}.jpg`);
        st.stage='sum';
        st.temp.push(body.message.message_id);
        const m = await sendMessage(chatId,'💰 Укажите сумму (только цифры):');
        st.temp.push(m.data.result.message_id);
        return res.sendStatus(200);
      }
      // б) Сумма
      if (st.stage==='sum' && body.message.text) {
        st.sum = body.message.text.replace(/\D/g,'');
        st.stage='comment';
        st.temp.push(body.message.message_id);
        const m = await sendMessage(chatId,'📝 Введите комментарий:');
        st.temp.push(m.data.result.message_id);
        return res.sendStatus(200);
      }
      // в) Комментарий
      if (st.stage==='comment' && body.message.text) {
        const comment = body.message.text;
        st.temp.push(body.message.message_id);

        // отправляем в GAS
        await axios.post(GAS_URL,{
          message_id: st.id,
          photo:       st.photo,
          sum:         st.sum,
          comment,
          executor:    `@${st.user}`
        });
        // правим исходное
        await axios.post(`${TELEGRAM_API}/editMessageText`,{
          chat_id:    chatId,
          message_id: st.id,
          text:
            `📌 Заявка #${st.id} закрыта.\n`+
            `📎 Фото: <a href="${st.photo}">ссылка</a>\n`+
            `💰 Сумма: ${st.sum} сум\n`+
            `👤 Исполнитель: @${st.user}\n`+
            `✅ Статус: Выполнено`,
          parse_mode:'HTML'
        });
        // удаляем временные
        setTimeout(()=>st.temp.forEach(mid=>deleteMessage(chatId,mid)),60_000);
        delete userState[chatId];
        return res.sendStatus(200);
      }
    }

    // ни одно не подошло
    res.sendStatus(200);
  }
  catch(err){
    console.error('❌ WEBHOOK ERROR:', err.stack||err);
    res.sendStatus(500);
  }
});

// порт и запуск
const PORT = process.env.PORT;
if (!PORT) throw new Error('PORT must be defined');
app.listen(PORT, ()=>console.log(`✅ Server listening on ${PORT}`));

