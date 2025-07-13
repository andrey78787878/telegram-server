// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

  function buildExecutorButtons(row) {
    return {
      inline_keyboard: EXECUTORS.map(ex => [
        { text: ex, callback_data: `select_executor:${row}:${ex}` }
      ])
    };
  }

  async function sendMessage(chatId, text, options = {}) {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });
    return res.data.result.message_id;
  }

  async function editMessageText(chatId, messageId, text, reply_markup) {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...(reply_markup && { reply_markup })
    });
  }

  async function deleteMessage(chatId, msgId, finalId) {
    if (msgId === finalId) return;
    axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: msgId
    }).catch(() => {});
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      if (body.callback_query) {
        const { data: raw, message, from } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const username = '@' + (from.username || from.first_name);

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        if (action === 'in_progress') {
          const keyboard = buildExecutorButtons(row);
          const msgId = await sendMessage(chatId, `Выберите исполнителя для заявки #${row}:`, {
            reply_markup: keyboard
          });
          userStates[chatId] = { row, sourceMessageId: messageId };
          setTimeout(() => deleteMessage(chatId, msgId, messageId), 60000);
          return res.sendStatus(200);
        }

        if (action === 'select_executor') {
          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            await sendMessage(chatId, 'Введите имя подрядчика вручную:');
            return res.sendStatus(200);
          }

          await axios.post(GAS_WEB_APP_URL, { action: 'in_progress', row, executor });

          let updatedText = '';
          try {
            const response = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row });
            updatedText = response.data.text || '';
            if (!updatedText.includes('🟢 В работе')) {
              updatedText += `\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
            }
          } catch {
            updatedText = `🟢 В работе\n👷 Исполнитель: ${executor}`;
          }

          const buttons = {
            inline_keyboard: [
              [
                { text: 'Выполнено ✅', callback_data: `done:${row}` },
                { text: 'Ожидает поставки ⏳', callback_data: `delayed:${row}` },
                { text: 'Отмена ❌', callback_data: `cancelled:${row}` }
              ]
            ]
          };

          await editMessageText(chatId, messageId, updatedText, buttons);
          userStates[chatId] = { row, sourceMessageId: messageId, executor };
          return res.sendStatus(200);
        }

        if (action === 'done') {
          userStates[chatId] = {
            row,
            stage: 'awaiting_photo',
            messageId,
            sourceMessageId: messageId,
            executor: userStates[chatId]?.executor,
            serviceMessages: []
          };
          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения.');
          userStates[chatId].serviceMessages.push(prompt);
          return res.sendStatus(200);
        }
      }

      if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const msgId = msg.message_id;
        const text = msg.text;
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);

        if (state.awaiting_manual_executor) {
          const executor = text.trim();
          await axios.post(GAS_WEB_APP_URL, { action: 'in_progress', row: state.row, executor });
          const updatedText = `🟢 В работе\n👷 Исполнитель: ${executor}`;
          await editMessageText(chatId, state.sourceMessageId, updatedText);
          delete userStates[chatId];
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_photo' && msg.photo) {
          const fileId = msg.photo.at(-1).file_id;
          const fileData = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
          const filePath = fileData.data.result.file_path;
          state.photo = `${TELEGRAM_FILE_API}/${filePath}`;
          state.stage = 'awaiting_sum';
          state.serviceMessages.push(msgId);
          const sumPrompt = await sendMessage(chatId, '💰 Введите сумму в сумах.');
          state.serviceMessages.push(sumPrompt);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_sum') {
          if (!/^[0-9]+$/.test(text)) {
            const warn = await sendMessage(chatId, '❗ Введите сумму цифрами.');
            state.serviceMessages.push(warn);
            return res.sendStatus(200);
          }
          state.sum = text;
          state.stage = 'awaiting_comment';
          state.serviceMessages.push(msgId);
          const commentPrompt = await sendMessage(chatId, '✏️ Введите комментарий.');
          state.serviceMessages.push(commentPrompt);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_comment') {
          const comment = text.trim();
          const { row, sum, photo, sourceMessageId, executor } = state;

          const response = await axios.post(GAS_WEB_APP_URL, {
            action: 'updateAfterCompletion',
            row,
            sum,
            comment,
            photoUrl: photo,
            executor
          });

          const r = response.data.result || {};
          const summaryText = `📌 Заявка #${row} закрыта.\n\n📍 Пиццерия: ${r.branch}\n📋 Проблема: ${r.problem}\n💬 Комментарий: ${comment}\n📎 Фото: <a href=\"${photo}\">ссылка</a>\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${executor}\n✅ Статус: Выполнено\n⏱ Просрочка: ${r.delay || 0} дн.`;

          await sendMessage(chatId, summaryText, { reply_to_message_id: sourceMessageId });

          await editMessageText(chatId, sourceMessageId, '📌 Заявка закрыта\n\n' + r.originalText, { inline_keyboard: [] });

          state.serviceMessages.forEach(mid => deleteMessage(chatId, mid, sourceMessageId));
          delete userStates[chatId];
          return res.sendStatus(200);
        }
      }

      return res.sendStatus(200);
    } catch (err) {
      console.error('❌ Ошибка обработки webhook:', err);
      res.sendStatus(500);
    }
  });
};
