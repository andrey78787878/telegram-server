require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const app = express();

app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}/`;

const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

let userStates = {};

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'certs/service_account.json'),
  scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

function sendTelegram(method, data) {
  return axios.post(`${TELEGRAM_API}/${method}`, data);
}

function deleteMessage(chat_id, message_id, delay = 60000) {
  setTimeout(() => {
    sendTelegram('deleteMessage', { chat_id, message_id }).catch(() => {});
  }, delay);
}

app.post('/webhook', async (req, res) => {
  const body = req.body;
  try {
    if (body.callback_query) {
      const data = body.callback_query.data;
      const from = body.callback_query.from;
      const chat_id = body.callback_query.message.chat.id;
      const message_id = body.callback_query.message.message_id;

      if (data.startsWith('accept_')) {
        const row = data.split('_')[1];
        userStates[chat_id] = { row, stage: null };

        await sendTelegram('editMessageReplyMarkup', {
          chat_id,
          message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: `В работе 🟢 ${from.username ? '@' + from.username : from.first_name}`, callback_data: 'inwork' }]
            ]
          }
        });

        await sendTelegram('sendMessage', {
          chat_id,
          text: `Заявка #${row} закреплена за ${from.username ? '@' + from.username : from.first_name}`,
          reply_to_message_id: message_id
        }).then(res => deleteMessage(chat_id, res.data.result.message_id));

        await axios.post(GAS_WEB_APP_URL, {
          action: 'accept',
          row,
          executor: from.username ? '@' + from.username : from.first_name,
          message_id
        });

      } else if (data === 'inwork') {
        await sendTelegram('sendMessage', {
          chat_id,
          text: 'Выберите действие:',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Выполнено', callback_data: 'done' }],
              [{ text: '📦 Ожидает поставки', callback_data: 'waiting' }],
              [{ text: '❌ Отмена', callback_data: 'cancel' }]
            ]
          }
        });

      } else if (data === 'done') {
        userStates[chat_id].stage = 'photo';
        const reply = await sendTelegram('sendMessage', {
          chat_id,
          text: '📷 Отправьте фото выполненных работ:'
        });
        userStates[chat_id].message_ids = [reply.data.result.message_id];

      } else if (data === 'cancel') {
        await sendTelegram('sendMessage', {
          chat_id,
          text: '❌ Заявка отменена.'
        });

      } else if (data === 'waiting') {
        await sendTelegram('sendMessage', {
          chat_id,
          text: '📦 Статус: ожидает поставки.'
        });
      }

    } else if (body.message && userStates[body.message.chat.id]) {
      const state = userStates[body.message.chat.id];
      const chat_id = body.message.chat.id;
      const message_id = body.message.message_id;
      state.message_ids.push(message_id);

      if (state.stage === 'photo' && body.message.photo) {
        const file_id = body.message.photo[body.message.photo.length - 1].file_id;
        const fileLink = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
        const filePath = fileLink.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}${filePath}`;

        const fileName = `done_${Date.now()}.jpg`;
        const localPath = path.join(__dirname, fileName);

        const response = await axios.get(fileUrl, { responseType: 'stream' });
        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);
        await new Promise(resolve => writer.on('finish', resolve));

        const fileMetadata = {
          name: fileName,
          parents: [FOLDER_ID]
        };
        const media = {
          mimeType: 'image/jpeg',
          body: fs.createReadStream(localPath)
        };

        const file = await drive.files.create({
          resource: fileMetadata,
          media,
          fields: 'id'
        });

        const fileId = file.data.id;
        await drive.permissions.create({
          fileId,
          requestBody: {
            role: 'reader',
            type: 'anyone'
          }
        });

        const photoUrl = `https://drive.google.com/uc?id=${fileId}`;
        state.photo = photoUrl;
        fs.unlinkSync(localPath);

        const reply = await sendTelegram('sendMessage', {
          chat_id,
          text: '💰 Укажите сумму работ:'
        });
        state.stage = 'sum';
        state.message_ids.push(reply.data.result.message_id);

      } else if (state.stage === 'sum' && body.message.text) {
        state.sum = body.message.text;

        const reply = await sendTelegram('sendMessage', {
          chat_id,
          text: '📝 Напишите комментарий:'
        });
        state.stage = 'comment';
        state.message_ids.push(reply.data.result.message_id);

      } else if (state.stage === 'comment' && body.message.text) {
        state.comment = body.message.text;

        const row = state.row;
        const photo = state.photo;
        const sum = state.sum;
        const comment = state.comment;

        await axios.post(GAS_WEB_APP_URL, {
          action: 'done',
          row,
          photo,
          sum,
          comment,
          username: body.message.from.username ? '@' + body.message.from.username : body.message.from.first_name
        });

        const delay = 60000;
        for (const id of state.message_ids) {
          deleteMessage(chat_id, id, delay);
        }

        await sendTelegram('editMessageText', {
          chat_id,
          message_id: Number(row), // предполагаем, что row = message_id
          text: `📌 Заявка #${row} закрыта.\n📎 Фото: [ссылка](${photo})\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${body.message.from.username ? '@' + body.message.from.username : body.message.from.first_name}\n✅ Статус: Выполнено`,
          parse_mode: 'Markdown'
        });

        delete userStates[chat_id];
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Ошибка:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
