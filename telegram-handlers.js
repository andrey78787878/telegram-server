module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const AUTHORIZED_USERS = [
    '@EvelinaB87',
    '@Olim19',
    '@Oblayor_04_09',
    '@Andrey_Tkach_MB',
    '@Davr_85'
  ];

  app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const user = msg.from.username ? '@' + msg.from.username : '—';
      const text = msg.text || '';
      const replyTo = msg.reply_to_message;

      const state = userStates[chatId] || {};

      if (state.waitingFor === 'photo' && msg.photo) {
        const fileId = msg.photo.pop().file_id;
        userStates[chatId].photo = fileId;
        userStates[chatId].waitingFor = 'sum';

        await sendMessage(chatId, '💰 Введите сумму работ:');
        return res.sendStatus(200);
      }

      if (state.waitingFor === 'sum') {
        userStates[chatId].sum = text;
        userStates[chatId].waitingFor = 'comment';

        await sendMessage(chatId, '💬 Введите комментарий:');
        return res.sendStatus(200);
      }

      if (state.waitingFor === 'comment') {
        userStates[chatId].comment = text;
        const { photo, sum, row, message_id } = userStates[chatId];

        // Загрузка фото
        const fileLink = await getFileLink(photo);
        const uploadRes = await axios.post(GAS_WEB_APP_URL, {
          photo: fileLink,
          sum: sum,
          comment: text,
          message_id: message_id,
          row: row,
          username: user,
          executor: user
        });

        const {
          delayDays,
          pizzaname,
          category,
          problem,
          initiator,
          driveUrl,
          rowNumber
        } = uploadRes.data;

        const finalText = 
`📌 Заявка #${rowNumber} закрыта.
📎 Фото: ссылка (${driveUrl})
💰 Сумма: ${sum} сум
👤 Исполнитель: ${user}
✅ Статус: Выполнено
🔴 Просрочка: ${delayDays} дн.

💬 Комментарий: ${text}

━━━━━━━━━━━━

📍 Заявка #${rowNumber}
🏢 Пиццерия: ${pizzaname}
📂 Категория: ${category}
🛠 Проблема: ${problem}
🙋 Инициатор: ${initiator}`;

        await sendMessage(chatId, finalText);
        delete userStates[chatId];
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (body.callback_query) {
      const query = body.callback_query;
      const msg = query.message;
      const chatId = msg.chat.id;
      const user = query.from.username ? '@' + query.from.username : '—';
      const data = query.data;
      const message_id = msg.message_id;
      const rowMatch = msg.text.match(/#(\d+)/);
      const row = rowMatch ? rowMatch[1] : null;

      if (!AUTHORIZED_USERS.includes(user)) {
        await answerCallback(query.id, '⛔ Доступ запрещён');
        return res.sendStatus(200);
      }

      if (data === 'accept') {
        // Кнопки выбора исполнителя
        const inlineKeyboard = AUTHORIZED_USERS.map(name => [{ text: name, callback_data: `executor_${name}` }]);
        await sendMessage(chatId, `👤 Выберите исполнителя заявки #${row}:`, {
          reply_markup: { inline_keyboard: inlineKeyboard }
        });

        await answerCallback(query.id, 'Выберите исполнителя');
        return res.sendStatus(200);
      }

      if (data.startsWith('executor_')) {
        const executor = data.replace('executor_', '');
        await axios.post(GAS_WEB_APP_URL, {
          status: 'В работе',
          message_id,
          row,
          executor
        });

        await editMessage(chatId, message_id, `${msg.text}\n\n👷 Назначен исполнитель: ${executor}`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Выполнено', callback_data: 'done' }],
              [{ text: '🚚 Ожидает поставки', callback_data: 'wait' }],
              [{ text: '❌ Отмена', callback_data: 'cancel' }]
            ]
          }
        });

        // Тег исполнителя
        await sendMessage(chatId, `Заявка #${row} — назначен исполнитель ${executor}`, {
          reply_to_message_id: message_id
        });

        await answerCallback(query.id, 'Исполнитель назначен');
        return res.sendStatus(200);
      }

      if (data === 'done') {
        userStates[chatId] = {
          waitingFor: 'photo',
          message_id,
          row
        };

        await sendMessage(chatId, '📸 Пришлите фото выполненных работ:');
        await answerCallback(query.id);
        return res.sendStatus(200);
      }

      if (data === 'cancel' || data === 'wait') {
        await axios.post(GAS_WEB_APP_URL, {
          status: data === 'cancel' ? 'Отменено' : 'Ожидает поставки',
          message_id,
          row
        });

        await editMessage(chatId, message_id, `${msg.text}\n\n⏹ Статус: ${data === 'cancel' ? 'Отменено' : 'Ожидает поставки'}`);
        await answerCallback(query.id, 'Статус обновлён');
        return res.sendStatus(200);
      }

      await answerCallback(query.id);
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  });

  async function sendMessage(chatId, text, options = {}) {
    return axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
  }

  async function editMessage(chatId, messageId, text, options = {}) {
    return axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options
    });
  }

  async function answerCallback(callbackQueryId, text = '') {
    return axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    });
  }

  async function getFileLink(fileId) {
    const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const path = res.data.result.file_path;
    return `${TELEGRAM_FILE_API}/${path}`;
  }
};
