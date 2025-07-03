const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { buildFollowUpButtons } = require('./messageUtils');

const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyiYYTXGbezDWwKT9kuHoVE5NjZ1C2dKmDQRwUTwITI0p3m9wF-ZI9L2cbh_O9VbQH0/exec';

// Храним состояния по ключу chatId:userId
const userStates = {};

app.post('/webhook', async (req, res) => {
  console.log('Получен запрос /webhook:', JSON.stringify(req.body).slice(0, 1000));

  const body = req.body;

  try {
    if (body.callback_query) {
      const { data, message, from } = body.callback_query;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const userId = from.id;
      const username = from.username || '';
      const fullMessage = message.text || '';

      const userKey = `${chatId}:${userId}`;

      console.log(`Callback query received. Data: ${data}, chatId: ${chatId}, username: @${username}`);

      let parsedData = {};
      try {
        parsedData = JSON.parse(data);
      } catch {
        const parts = data.split('_');
        parsedData.action = parts[0];
        parsedData.messageId = parts[1];
      }

      const { action, messageId: row } = parsedData;

      if (!row) {
        console.warn('Не удалось найти номер заявки в callback_data.');
        return res.sendStatus(200);
      }

      if (action === 'accept' || action === 'inprogress' || action === 'in_progress') {
        const newText = `${fullMessage}\n\n🟢 В работе\n👷 Исполнитель: @${username}`;
        const buttons = buildFollowUpButtons(row);

        console.log('Обновляем сообщение с кнопками:', buttons);

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: newText,
          parse_mode: 'HTML',
          reply_markup: buttons,  // <- Важно: передаём объект, не строку и не вложенный inline_keyboard
        });

        await axios.post(GAS_URL, {
          status: 'В работе',
          row,
          username,
        });

        return res.sendStatus(200);
      }

      if (action === 'done' || action === 'completed') {
        userStates[userKey] = {
          step: 'waiting_photo',
          row,
          message_id: messageId,
          username,
          serviceMessages: [],
        };

        console.log(`Ожидаем фото от исполнителя @${username} по заявке №${row}`);

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Пожалуйста, отправьте фото выполненной работы.',
        });

        userStates[userKey].serviceMessages.push(reply.data.result.message_id);
        return res.sendStatus(200);
      }

      if (action === 'delayed' || action === 'cancelled') {
        const statusText = action === 'delayed' ? 'Ожидает поставки' : 'Отменено';

        console.log(`Обновляем статус заявки №${row} на "${statusText}"`);

        await axios.post(GAS_URL, { status: statusText, row, username });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Заявка №${row} переведена в статус "${statusText}".`,
        });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (body.message && body.message.photo) {
      const chatId = body.message.chat.id;
      const userId = body.message.from.id;
      const userKey = `${chatId}:${userId}`;
      const state = userStates[userKey];

      if (!state) {
        console.log('Фото получено, но нет состояния пользователя. Игнорируем.');
        return res.sendStatus(200);
      }

      if (state.step === 'waiting_photo') {
        console.log(`Получено фото от пользователя @${state.username} для заявки №${state.row}`);

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
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        const formData = new FormData();
        formData.append('photo', fs.createReadStream(localFilePath));
        formData.append('row', state.row);
        formData.append('username', state.username);
        formData.append('message_id', state.message_id);

        const uploadResponse = await axios.post(GAS_URL, formData, {
          headers: formData.getHeaders(),
        });

        fs.unlinkSync(localFilePath);

        userStates[userKey].photoUrl = uploadResponse.data.photoUrl || '';
        userStates[userKey].step = 'waiting_sum';

        console.log(`Фото загружено, просим ввести сумму выполненных работ.`);

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Теперь введите сумму выполненных работ (только число):',
        });

        userStates[userKey].serviceMessages.push(body.message.message_id, reply.data.result.message_id);
        return res.sendStatus(200);
      }
    }

    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const userId = body.message.from.id;
      const userKey = `${chatId}:${userId}`;
      const text = body.message.text.trim();
      const state = userStates[userKey];

      if (!state) {
        console.log('Текст получен, но нет состояния пользователя. Игнорируем.');
        return res.sendStatus(200);
      }

      if (state.step === 'waiting_sum') {
        console.log(`Получена сумма: ${text} от @${state.username} для заявки №${state.row}`);

        if (!/^\d+$/.test(text)) {
          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: 'Ошибка: введите сумму числом (только цифры). Попробуйте ещё раз:',
          });
          return res.sendStatus(200);
        }

        userStates[userKey].sum = text;
        userStates[userKey].step = 'waiting_comment';

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Добавьте комментарий (или введите "-" если без комментария):',
        });

        userStates[userKey].serviceMessages.push(body.message.message_id, reply.data.result.message_id);
        return res.sendStatus(200);
      }

      if (state.step === 'waiting_comment') {
        console.log(`Получен комментарий: ${text} от @${state.username} для заявки №${state.row}`);
        state.comment = text;

        const payload = {
          row: state.row,
          username: state.username,
          sum: state.sum,
          comment: state.comment,
          message_id: state.message_id,
        };

        console.log('Отправляем данные в GAS:', payload);
        await axios.post(GAS_URL, payload);

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

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: finalText,
          parse_mode: 'HTML',
          reply_to_message_id: state.message_id,
        });

        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: state.message_id,
          text: finalText,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }, // Убираем кнопки
        });

        // Удаляем промежуточные сообщения через 60 секунд
        const allToDelete = [...(state.serviceMessages || []), body.message.message_id];
        allToDelete.forEach(msgId => {
          setTimeout(() => {
            axios.post(`${TELEGRAM_API}/deleteMessage`, {
              chat_id: chatId,
              message_id: msgId,
            }).catch(() => {});
          }, 60000);
        });

        delete userStates[userKey];
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Ошибка:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
