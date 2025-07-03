const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { buildFollowUpButtons } = require('./messageUtils'); // функция для создания кнопок

const app = express();
app.use(express.json());

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyiYYTXGbezDWwKT9kuHoVE5NjZ1C2dKmDQRwUTwITI0p3m9wF-ZI9L2cbh_O9VbQH0/exec';

const userStates = {}; // хранение состояний пользователей

app.post('/webhook', async (req, res) => {
  console.log('Получен запрос /webhook:', JSON.stringify(req.body).slice(0, 1000));

  const body = req.body;

  try {
    // Обработка callback_query (нажатия на inline кнопки)
    if (body.callback_query) {
      const { data, message, from } = body.callback_query;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const username = from.username || '';
      const fullMessage = message.text || '';

      console.log(`Callback query received. Data: ${data}, chatId: ${chatId}, username: @${username}`);

      // Парсим действие и номер заявки из callback_data (ожидаем формат action_row, например "accept_138")
      const [action, row] = data.split('_');
      if (!row) {
        console.warn('Не удалось найти номер заявки в callback_data.');
        return res.sendStatus(200);
      }

      // Обработка кнопки "Принято в работу" (accept, inprogress, in_progress)
      if (action === 'accept' || action === 'inprogress' || action === 'in_progress') {
        const newText = `${fullMessage}\n\n🟢 В работе\n👷 Исполнитель: @${username}`;
        const buttons = buildFollowUpButtons(row); // массив массивов с кнопками

        console.log('Обновляем сообщение с кнопками:', buttons);

        // Отправляем запрос на редактирование сообщения с новым текстом и кнопками
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: chatId,
          message_id: messageId,
          text: newText,
          reply_markup: { inline_keyboard: buttons }
        });

        // Отправляем данные в Google Apps Script для обновления статуса
        await axios.post(GAS_URL, {
          status: 'В работе',
          row,
          username
        });

        return res.sendStatus(200);
      }

      // Кнопка "Выполнено"
      if (action === 'done' || action === 'completed' || data === 'completed') {
        userStates[chatId] = {
          step: 'waiting_photo',
          row,
          message_id: messageId,
          username,
          serviceMessages: []
        };

        console.log(`Ожидаем фото от исполнителя @${username} по заявке №${row}`);

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Пожалуйста, отправьте фото выполненной работы.'
        });

        userStates[chatId].serviceMessages.push(reply.data.result.message_id);
        return res.sendStatus(200);
      }

      // Кнопки "Ожидает поставки" и "Отмена"
      if (action === 'delayed' || action === 'cancelled' || data === 'delayed' || data === 'cancelled') {
        const statusText = (action === 'delayed' || data === 'delayed') ? 'Ожидает поставки' : 'Отменено';

        console.log(`Обновляем статус заявки №${row} на "${statusText}"`);

        await axios.post(GAS_URL, { status: statusText, row, username });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Заявка №${row} переведена в статус "${statusText}".`
        });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // Обработка фотографий от пользователя
    if (body.message && body.message.photo) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId];

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

        console.log(`Фото загружено, просим ввести сумму выполненных работ.`);

        const reply = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Теперь введите сумму выполненных работ (только число):'
        });

        userStates[chatId].serviceMessages.push(body.message.message_id, reply.data.result.message_id);
        return res.sendStatus(200);
      }
    }

    // Обработка текста от пользователя (сумма и комментарий)
    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      const state = userStates[chatId];

      if (!state) {
        console.log('Текст получен, но нет состояния пользователя. Игнорируем.');
        return res.sendStatus(200);
      }

      if (state.step === 'waiting_sum') {
        console.log(`Получена сумма: ${text} от @${state.username} для заявки №${state.row}`);
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
        console.log(`Получен комментарий: ${text} от @${state.username} для заявки №${state.row}`);
        state.comment = text;

        const payload = {
          row: state.row,
          username: state.username,
          sum: state.sum,
          comment: state.comment,
          message_id: state.message_id
        };

        // Отправка всех данных в GAS
        console.log('Отправляем данные в GAS:', payload);
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

        // Удаляем промежуточные сообщения через 60 секунд
        const allToDelete = [...(state.serviceMessages || []), body.message.message_id];
        allToDelete.forEach(msgId => {
          setTimeout(() => {
            axios.post(`${TELEGRAM_API}/deleteMessage`, {
              chat_id: chatId,
              message_id: msgId
            }).catch(() => { });
          }, 60000);
        });

        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }

    // Любые другие апдейты просто подтверждаем
    res.sendStatus(200);

  } catch (err) {
    console.error('Ошибка:', err);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log('Сервер запущен на порту 3000');
});
