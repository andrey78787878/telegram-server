require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const PORT = process.env.PORT || 3000;

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// 🔁 Приходит Telegram webhook
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // 🔍 DEBUG
    console.log('🟨 Webhook body:', JSON.stringify(body, null, 2));

    if (body.callback_query) {
      const { id, data, message, from } = body.callback_query;
      const [action, ticketNumber, row] = data.split(':');
      const chat_id = message.chat.id;
      const username = from.username || from.first_name;

      console.log(`➡️ Callback: ${action}:${ticketNumber}:${row}`);

      if (action === 'in_progress') {
        // ✅ Запись в таблицу
        await axios.post(GAS_WEB_APP_URL, {
          action: 'in_progress',
          row,
          status: 'В работе',
          executor: username,
          message_id: message.message_id
        });

        // ✅ Обновляем материнское сообщение
        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id,
          message_id: message.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Выполнено ✅', callback_data: `done:${ticketNumber}:${row}` },
              { text: 'Ожидает поставки 🕓', callback_data: `delayed:${ticketNumber}:${row}` },
              { text: 'Отмена ❌', callback_data: `cancel:${ticketNumber}:${row}` }
            ]]
          }
        });

        // ✅ Ответ пользователю
        const sent = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `🛠 Исполнитель: @${username} принял заявку #${ticketNumber} в работу.`,
          reply_to_message_id: message.message_id
        });

        // ⏱ Удаление через 60 сек
        setTimeout(() => {
          axios.post(`${TELEGRAM_API}/deleteMessage`, {
            chat_id,
            message_id: sent.data.result.message_id
          }).catch(() => {});
        }, 60_000);
      }

      if (action === 'done') {
        // ✅ Запрос фото
        const askPhoto = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: `📸 Пришли фото выполненной заявки #${ticketNumber}`,
          reply_markup: { force_reply: true }
        });

        // ⏳ Сохраняем состояние (можно через базу/файл, здесь упрощённо)
        fs.writeFileSync('state.json', JSON.stringify({
          step: 'wait_photo',
          chat_id,
          row,
          ticketNumber,
          reply_to_message_id: askPhoto.data.result.message_id,
          username
        }));
      }

      return res.sendStatus(200);
    }

    if (body.message && body.message.photo) {
      const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
      if (state.step !== 'wait_photo') return res.sendStatus(200);

      const chat_id = body.message.chat.id;
      const file_id = body.message.photo.pop().file_id;
      const file_res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
      const file_path = file_res.data.result.file_path;
      const file_url = `${TELEGRAM_FILE_API}/${file_path}`;

      const local_path = `${TMP_DIR}/${file_id}.jpg`;
      const writer = fs.createWriteStream(local_path);
      const response = await axios({ url: file_url, method: 'GET', responseType: 'stream' });
      response.data.pipe(writer);
      await new Promise(resolve => writer.on('finish', resolve));

      // ⬆️ Загрузка на Google Drive (через GAS)
      const photoForm = new FormData();
      photoForm.append('photo', fs.createReadStream(local_path));
      photoForm.append('row', state.row);
      photoForm.append('ticketNumber', state.ticketNumber);
      photoForm.append('username', state.username);
      photoForm.append('action', 'upload_photo');

      const uploadRes = await axios.post(GAS_WEB_APP_URL, photoForm, {
        headers: photoForm.getHeaders()
      });

      // ✅ Запрос суммы
      const askSum = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: '💰 Введи сумму выполненных работ в сумах',
        reply_markup: { force_reply: true }
      });

      fs.writeFileSync('state.json', JSON.stringify({
        step: 'wait_sum',
        chat_id,
        row: state.row,
        ticketNumber: state.ticketNumber,
        photoLink: uploadRes.data.photoUrl,
        username: state.username,
        reply_to_message_id: askSum.data.result.message_id
      }));

      fs.unlinkSync(local_path); // удалим временный файл
    }

    if (body.message && body.message.text) {
      const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
      const chat_id = body.message.chat.id;

      if (state.step === 'wait_sum') {
        const sum = body.message.text;

        const askComment = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: '📝 Добавь комментарий по заявке',
          reply_markup: { force_reply: true }
        });

        fs.writeFileSync('state.json', JSON.stringify({
          step: 'wait_comment',
          chat_id,
          row: state.row,
          ticketNumber: state.ticketNumber,
          photoLink: state.photoLink,
          sum,
          username: state.username,
          reply_to_message_id: askComment.data.result.message_id
        }));
      }

      else if (state.step === 'wait_comment') {
        const comment = body.message.text;

        // ✅ Отправка всех данных в таблицу
        await axios.post(GAS_WEB_APP_URL, {
          action: 'done',
          row: state.row,
          photo: state.photoLink,
          sum: state.sum,
          comment,
          executor: state.username
        });

        const finalText = `
📌 Заявка #${state.ticketNumber} закрыта.
📎 Фото: ${state.photoLink}
💰 Сумма: ${state.sum} сум
👤 Исполнитель: @${state.username}
✅ Статус: Выполнено
`;

        const finalMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id,
          text: finalText
        });

        setTimeout(() => {
          axios.post(`${TELEGRAM_API}/deleteMessage`, {
            chat_id,
            message_id: finalMsg.data.result.message_id
          }).catch(() => {});
        }, 60_000);

        fs.unlinkSync('state.json');
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Ошибка в /webhook:', err.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
