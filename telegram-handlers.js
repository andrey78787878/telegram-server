// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const AUTHORIZED_USERS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB'];
  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

  const deleteMessageAfter = (chatId, messageId, delay = 15000) => {
    setTimeout(() => {
      axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => {});
    }, delay);
  };

  const sendAndDelete = async (chatId, text, opts = {}, delay = 60000) => {
    const msg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      ...opts,
    });
    deleteMessageAfter(chatId, msg.data.result.message_id, delay);
    return msg;
  };

  app.post('/webhook', async (req, res) => {
    const body = req.body;
    try {
      if (body.callback_query) {
        const query = body.callback_query;
        const fromUser = query.from.username ? `@${query.from.username}` : '';
        const data = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        if (!AUTHORIZED_USERS.includes(fromUser)) {
          await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: query.id,
            text: 'У вас нет прав выполнять это действие.',
            show_alert: true,
          });
          return res.sendStatus(200);
        }

        const [action, row, overrideExecutor] = data.split(':');
        const executor = overrideExecutor || fromUser;

        if (action === 'accept') {
          // Выбор исполнителя
          const buttons = EXECUTORS.map(name => ([{
            text: name,
            callback_data: `executor:${row}:${name}`
          }]));

          await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: buttons }
          });
        }

        if (action === 'executor') {
          // Установить исполнителя и статус "в работе"
          await axios.post(GAS_WEB_APP_URL, {
            action: 'accept',
            row,
            executor,
            message_id: messageId,
          });

          const gasResponse = await axios.post(GAS_WEB_APP_URL, {
            action: 'getRowData',
            row,
          });

          const d = gasResponse.data;

          const updatedText = 
`📍 Заявка #${d.row}
🏢 Пиццерия: ${d.branch}
📂 Категория: ${d.category}
🛠 Проблема: ${d.problem}

🙋 Инициатор: ${d.initiator}

🟢 В работе
👷 Исполнитель: ${executor}`;

          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: updatedText,
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Выполнено', callback_data: `done:${row}:${executor}` },
                { text: '🚚 Ожидает поставки', callback_data: `delayed:${row}:${executor}` },
                { text: '❌ Отмена', callback_data: `cancel:${row}:${executor}` }
              ]]
            }
          });
        }

        if (action === 'done') {
          userStates[chatId] = { step: 'photo', row, executor, messageId };
          const msg = await sendAndDelete(chatId, '📸 Пришлите фото выполненных работ:');
          userStates[chatId].messagesToDelete = [msg.data.result.message_id];
        }

        if (action === 'cancel' || action === 'delayed') {
          await axios.post(GAS_WEB_APP_URL, {
            action,
            row,
            executor,
            message_id: messageId
          });

          const label = action === 'cancel' ? '❌ Отменено' : '🚚 Ожидает поставки';

          await axios.post(`${TELEGRAM_API}/editMessageText`, {
            chat_id: chatId,
            message_id: messageId,
            text: `📌 Заявка #${row}\n👷 Исполнитель: ${executor}\nСтатус: ${label}`
          });
        }

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: query.id
        });
      }

      if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const text = msg.text;
        const photo = msg.photo;
        const username = msg.from.username ? `@${msg.from.username}` : '';
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);

        if (state.step === 'photo' && photo) {
          const fileId = photo[photo.length - 1].file_id;
          state.photo = fileId;
          state.step = 'sum';

          const m = await sendAndDelete(chatId, '💰 Укажите сумму выполненных работ:');
          state.messagesToDelete.push(m.data.result.message_id);
        } else if (state.step === 'sum' && text) {
          state.sum = text;
          state.step = 'comment';

          const m = await sendAndDelete(chatId, '💬 Напишите комментарий:');
          state.messagesToDelete.push(m.data.result.message_id);
        } else if (state.step === 'comment' && text) {
          state.comment = text;
          const { row, photo, sum, comment, executor, messageId, messagesToDelete } = state;

          const sendData = {
            action: 'complete',
            row,
            photo,
            sum,
            comment,
            executor,
            message_id: messageId
          };

          const result = await axios.post(GAS_WEB_APP_URL, sendData);
          const d = result.data;

          const finalText =
`📌 Заявка #${row} закрыта.
📎 Фото: [ссылка](${d.photo_url})
💰 Сумма: ${sum} сум
👤 Исполнитель: ${executor}
✅ Статус: Выполнено
🕒 Просрочка: ${d.delay || '0'} дн.
💬 Комментарий: ${comment}`;

          await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: finalText,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
          });

          messagesToDelete.push(msg.message_id);
          messagesToDelete.forEach(id => deleteMessageAfter(chatId, id));
          delete userStates[chatId];
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('Telegram handler error:', err.message);
      res.sendStatus(200);
    }
  });
};
