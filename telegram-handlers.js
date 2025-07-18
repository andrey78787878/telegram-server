// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
  const AUTHORIZED_USERS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85'];

  const EXECUTOR_USERNAMES = AUTHORIZED_USERS;

  app.post('/webhook', async (req, res) => {
    const body = req.body;
    console.log('Update:', JSON.stringify(body, null, 2));

    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const text = msg.text;
      const username = `@${msg.from.username}`;
      const messageId = msg.message_id;

      if (!AUTHORIZED_USERS.includes(username)) return res.sendStatus(200);

      const state = userStates[chatId];

      if (state && state.awaiting === 'photo') {
        if (msg.photo) {
          const fileId = msg.photo.pop().file_id;
          const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
          const filePath = fileRes.data.result.file_path;
          const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

          userStates[chatId].photoUrl = fileUrl;
          userStates[chatId].awaiting = 'sum';

          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: 'Введите сумму (в сумах):'
          });
        }
      } else if (state && state.awaiting === 'sum') {
        const sum = text;
        userStates[chatId].sum = sum;
        userStates[chatId].awaiting = 'comment';

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Введите комментарий:'
        });
      } else if (state && state.awaiting === 'comment') {
        const comment = text;
        const { photoUrl, sum, row, messageId, username } = userStates[chatId];

        await axios.post(GAS_WEB_APP_URL, {
          photo: photoUrl,
          sum,
          comment,
          row,
          message_id: messageId,
          username,
          executor: username
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `✅ Заявка #${row} закрыта.\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${username}`
        });

        delete userStates[chatId];
      }
    } else if (body.callback_query) {
      const data = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = `@${body.callback_query.from.username}`;

      if (!AUTHORIZED_USERS.includes(username)) return res.sendStatus(200);

      if (data.startsWith('assign_executor')) {
        const [, executor, originalMsgId] = data.split('|');

        await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] }
        });

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: `Заявка принята в работу исполнителем: ${executor}`
        });

        await axios.post(GAS_WEB_APP_URL, {
          message_id: originalMsgId,
          status: 'В работе',
          executor
        });

        const inlineKeyboard = [
          [{ text: 'Выполнено', callback_data: `done|${originalMsgId}` }],
          [{ text: 'Ожидает поставки', callback_data: `pending|${originalMsgId}` }],
          [{ text: 'Отмена', callback_data: `cancel|${originalMsgId}` }]
        ];

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Выберите действие по заявке:',
          reply_markup: { inline_keyboard: inlineKeyboard }
        });
      }

      if (data.startsWith('done')) {
        const [, msgId] = data.split('|');
        userStates[chatId] = { awaiting: 'photo', messageId: msgId, row: msgId, username };

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: 'Загрузите фото выполненных работ:'
        });
      }
    }

    res.sendStatus(200);
  });

  const sendExecutorChoice = async (chatId, messageId) => {
    const inlineKeyboard = EXECUTOR_USERNAMES.map(username => ([{
      text: `Назначить ${username}`,
      callback_data: `assign_executor|${username}|${messageId}`
    }]));

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: 'Выберите исполнителя:',
      reply_to_message_id: messageId,
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  };

  const sendFinalMessage = async (chatId, rowNumber, photoLink, sum, username, overdueDays, comment) => {
    const messageText =
      `📌 Заявка #${rowNumber} закрыта.\n` +
      `📎 Фото: [ссылка](${photoLink})\n` +
      `💰 Сумма: ${sum} сум\n` +
      `👤 Исполнитель: ${username}\n` +
      `✅ Статус: Выполнено\n` +
      `🕒 Просрочка: ${overdueDays} дн.\n` +
      (comment ? `💬 Комментарий: ${comment}` : '');

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: messageText,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  };

  return {
    sendExecutorChoice,
    sendFinalMessage
  };
};
