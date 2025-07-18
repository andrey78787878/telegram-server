// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
  const AUTHORIZED_USERS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB'];

  app.post('/webhook', async (req, res) => {
    const body = req.body;
    res.sendStatus(200);

    if (!body.message && !body.callback_query) return;

    const message = body.message || body.callback_query.message;
    const chat = message.chat;
    const text = body.message?.text;
    const from = body.message?.from || body.callback_query?.from;
    const callbackData = body.callback_query?.data;
    const username = from?.username ? `@${from.username}` : '';

    // ✅ Обработка команды /start
    if (text === '/start') {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chat.id,
        text: 'Привет! Я бот для работы с заявками 🛠️\nИспользуйте кнопки или команды, чтобы управлять заявками.',
      });
      return;
    }

    // ✅ Обработка команды /мои
    if (text === '/мои') {
      if (chat.type !== 'private') {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chat.id,
          text: '👋 Пожалуйста, напишите эту команду в личку боту, чтобы увидеть свои заявки.',
        });
        return;
      }

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chat.id,
        text: '🔍 Отправляю ваши заявки... (тут будет список)',
      });
      // 🔻 Здесь реализуется логика фильтрации и вывода заявок исполнителя по username
      return;
    }

    // ✅ Обработка инлайн-кнопок
    if (callbackData) {
      const [action, row, messageId] = callbackData.split('|');
      if (!AUTHORIZED_USERS.includes(username)) {
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: body.callback_query.id,
          text: '❌ У вас нет прав выполнять это действие.',
          show_alert: true,
        });
        return;
      }

      userStates[from.id] = userStates[from.id] || {};
      const state = userStates[from.id];

      if (action === 'in_progress') {
        state.row = row;
        state.username = username;

        await axios.post(`${GAS_WEB_APP_URL}`, {
          row,
          status: 'В работе 🟢',
          executor: username,
          message_id: messageId,
        });

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chat.id,
          message_id: message.message_id,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Выполнено ✅', callback_data: `done|${row}|${messageId}` },
              { text: 'Ожидает поставки 🕐', callback_data: `wait|${row}|${messageId}` },
              { text: 'Отмена ⛔️', callback_data: `cancel|${row}|${messageId}` },
            ]],
          },
        });

        return;
      }

      if (action === 'done') {
        state.expectingPhoto = true;
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chat.id,
          text: '📸 Пришлите фото выполненных работ',
        });
        return;
      }

      if (action === 'wait') {
        await axios.post(`${GAS_WEB_APP_URL}`, {
          row,
          status: 'Ожидает поставки 🕐',
          executor: username,
          message_id: messageId,
        });
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chat.id,
          text: '⏳ Заявка переведена в статус "Ожидает поставки"',
        });
        return;
      }

      if (action === 'cancel') {
        await axios.post(`${GAS_WEB_APP_URL}`, {
          row,
          status: 'Отменено ❌',
          executor: username,
          message_id: messageId,
        });
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chat.id,
          text: '🚫 Заявка отменена',
        });
        return;
      }
    }

    // ✅ Обработка фото, суммы, комментария после 'Выполнено'
    const state = userStates[from.id];
    if (!state) return;

    if (state.expectingPhoto && message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      state.photoFileId = fileId;
      state.expectingPhoto = false;
      state.expectingSum = true;

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chat.id,
        text: '💰 Введите сумму работ',
      });
      return;
    }

    if (state.expectingSum && text && !isNaN(Number(text))) {
      state.sum = text;
      state.expectingSum = false;
      state.expectingComment = true;

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chat.id,
        text: '✏️ Введите комментарий исполнителя',
      });
      return;
    }

    if (state.expectingComment && text) {
      state.comment = text;
      state.expectingComment = false;

      // ✅ Получение ссылки на файл
      const fileUrl = `${TELEGRAM_API}/getFile?file_id=${state.photoFileId}`;
      const fileRes = await axios.get(fileUrl);
      const filePath = fileRes.data.result.file_path;
      const fileLink = `${TELEGRAM_FILE_API}/${filePath}`;

      // ✅ Отправка данных в GAS
      await axios.post(`${GAS_WEB_APP_URL}`, {
        row: state.row,
        photo: fileLink,
        sum: state.sum,
        comment: state.comment,
        username: state.username,
      });

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chat.id,
        text: '✅ Данные отправлены и заявка закрыта',
      });

      delete userStates[from.id];
    }
  });
};
