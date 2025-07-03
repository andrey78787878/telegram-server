const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { createButtonsForStatus } = require('./messageUtils');

const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyiYYTXGbezDWwKT9kuHoVE5NjZ1C2dKmDQRwUTwITI0p3m9wF-ZI9L2cbh_O9VbQH0/exec';

const userStates = {}; // { [chatId]: { step, row, message_id, sum, username, comment, photoUrl, serviceMessages: [] } }

app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    // === CALLBACK ===
    if (body.callback_query) {
      const { data, message, from } = body.callback_query;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const username = from.username || '';
      const fullMessage = message.text;

      const rowMatch = fullMessage.match(/Заявка №(\d+)/);
      const row = rowMatch ? rowMatch[1] : null;

      if (data === 'in_progress') {
        const newText = `${fullMessage}\n\n🟢 В работе\n👷 Исполнитель: @${username}`;
        const buttons = createButtonsForStatus(row);

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: newText,
          reply_markup: { inline_keyboard: buttons }
        });

        await axios.post(GAS_URL, {
          status: 'В работе',
          row,
          username
        });

        return res.sendStatus(200);
      }

      if (data === 'completed') {
        userStates[chatId] = {
          step: 'waiting_photo',
          row,
          message_id: messageId,
          username,
          serviceMessages: []
        };

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Пожалуйста, отправьте фото выполненной работы.'
        });

        userStates[chatId].serviceMessages.push(reply.data.result.message_id);
        return res.sendStatus(200);
      }

      if (data === 'delayed' || data === 'cancelled') {
        const statusText = data === 'delayed' ? 'Ожидает поставки' : 'Отменено';
        await axios.post(GAS_URL, { status: statusText, row, username });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Заявка №${row} переведена в статус "${statusText}".`
        });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // === PHOTO ===
    if (body.message && body.message.photo) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId];

      if (state?.step === 'waiting_photo') {
        const photoArray = body.message.photo;
        const fileId = photoArray[photoArray.length - 1].file_id;

        const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileInfo.data.result.file_path;

        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
        const fileExt = path.extname(filePath);
        const localFilePath = path.join(__dirname, `photo_${Date.now()}${fileExt}`);

        const photoStream = await axios.get(fileUrl, { responseType: 'stream' });
        const writer = fs.createWriteStream(localFilePath);
        photoStream.data.pipe(writer);
        await new Promise(resolve => writer.on('finish', resolve));

        const formData = new FormData();
        formData.append('photo', fs.createReadStream(localFilePath));
        formData.append('row', state.row);
        formData.append('username', state.username);
        formData.append('message_id', state.message_id);

        const uploadResponse = await axios.post(GAS_URL, formData, {
          headers: formData.getHeaders()
        });

        fs.unlinkSync(localFilePath);

        userStates[chatId].photoUrl = uploadResponse.data.photoUrl; // ссылка от GAS
        userStates[chatId].step = 'waiting_sum';

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Теперь введите сумму выполненных работ (только число):'
        });

        userStates[chatId].serviceMessages.push(body.message.message_id, reply.data.result.message_id);
        return res.sendStatus(200);
      }
    }

    // === TEXT ===
    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      const state = userStates[chatId];

      if (!state) return res.sendStatus(200);

      if (state.step === 'waiting_sum') {
        userStates[chatId].sum = text;
        userStates[chatId].step = 'waiting_comment';

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Добавьте комментарий (или "-" если без комментария):'
        });

        userStates[chatId].serviceMessages.push(body.message.message_id, reply.data.result.message_id);
        return res.sendStatus(200);
      }

      if (state.step === 'waiting_comment') {
        state.comment = text;

        const payload = {
          row: state.row,
          username: state.username,
          sum: state.sum,
          comment: state.comment,
          message_id: state.message_id
        };

        // Отправка всех данных в GAS
        await axios.post(GAS_URL, payload);

        // Получаем просрочку
        const overdueResp = await axios.post(GAS_URL, { row: state.row, action: 'get_overdue' });
        const overdue = overdueResp.data.overdue || '0';

        const finalText = `
📌 Заявка №${state.row} закрыта.
📎 Фото: <a href="${state.photoUrl}">ссылка</a>
💰 Сумма: ${state.sum} сум
👤 Исполнитель: @${state.username}
✅ Статус: Выполнено
⏰ Просрочка: ${overdue} дн.
        `.trim();

        // Ответом на исходное сообщение
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: finalText,
          parse_mode: 'HTML',
          reply_to_message_id: state.message_id
        });

        // Редактируем материнское сообщение
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: state.message_id,
          text: finalText,
          parse_mode: 'HTML'
        });

        // Удаляем промежуточные сообщения
        const allToDelete = [...(state.serviceMessages || []), body.message.message_id];
        allToDelete.forEach(msgId => {
          setTimeout(() => {
            axios.post(`${TELEGRAM_API}/deleteMessage`, {
              chat_id: chatId,
              message_id: msgId
            }).catch(() => { });
          }, 60000); // через 60 секунд
        });

        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка:', err.message);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log('Сервер запущен на порту 3000');
});
