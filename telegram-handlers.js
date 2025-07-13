// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];

  function buildFollowUpButtons(row) {
    return {
      inline_keyboard: [[
        { text: 'Выполнено ✅', callback_data: `completed:${row}` },
        { text: 'Ожидает поставки ⏳', callback_data: `delayed:${row}` },
        { text: 'Отмена ❌', callback_data: `cancelled:${row}` },
      ]]
    };
  }

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

  async function askForPhoto(chatId) {
    const msgId = await sendMessage(chatId, '📸 Пожалуйста, пришлите фото выполненных работ.');
    userStates[chatId] ??= { serviceMessages: [] };
    userStates[chatId].serviceMessages.push(msgId);
  }

  async function askForSum(chatId) {
    const msgId = await sendMessage(chatId, '💰 Введите сумму работ в сумах (только цифры).');
    userStates[chatId].serviceMessages.push(msgId);
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;
      console.log('📩 Получен update:', JSON.stringify(body, null, 2));

      if (body.callback_query) {
        const { data: raw, message, from } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const username = '@' + (from.username || from.first_name);

        let parts;
        try {
          parts = raw.startsWith('{') ? JSON.parse(raw) : raw.split(':');
        } catch (err) {
          console.error('❌ Ошибка парсинга callback_data:', raw, err);
          return res.sendStatus(200);
        }

        const action = parts.action || parts[0];
        const row = Number(parts.row || parts[1]);
        const executor = parts.executor || parts[2] || null;

        if (action === 'in_progress') {
          userStates[chatId] = { row, messageId };
          try {
            const response = await axios.post(GAS_WEB_APP_URL, { action: 'getOriginalText', row });
            userStates[chatId].originalText = response.data.text || message.text;
          } catch {
            userStates[chatId].originalText = message.text;
          }

          const keyboard = buildExecutorButtons(row);
          const infoMsgId = await sendMessage(chatId, `Выберите исполнителя для заявки #${row}:`, {
            reply_to_message_id: messageId,
            reply_markup: keyboard
          });

          setTimeout(() => {
            axios.post(`${TELEGRAM_API}/deleteMessage`, {
              chat_id: chatId,
              message_id: infoMsgId
            }).catch(() => {});
          }, 60000);

          return res.sendStatus(200);
        }

        if (action === 'select_executor' && executor) {
          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].stage = 'awaiting_executor_name';
            await sendMessage(chatId, 'Введите имя подрядчика вручную:');
            return res.sendStatus(200);
          }

          const originalText = userStates[chatId]?.originalText || message.text;
          const cleanedText = originalText
            .replace(/🟢 В работе.*\n?/g, '')
            .replace(/👷 Исполнитель:.*\n?/g, '')
            .trim();

          const updatedText = `${cleanedText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;

          const keyboard = {
            inline_keyboard: [
              [{ text: `✅ В работе ${executor}`, callback_data: 'noop' }],
              [
                { text: 'Выполнено', callback_data: JSON.stringify({ action: 'done', row, messageId }) },
                { text: 'Ожидает поставки', callback_data: JSON.stringify({ action: 'delayed', row, messageId }) },
                { text: 'Отмена', callback_data: JSON.stringify({ action: 'cancel', row, messageId }) }
              ]
            ]
          };

          await editMessageText(chatId, messageId, updatedText, keyboard);

          await axios.post(GAS_WEB_APP_URL, {
            action: 'in_progress',
            row,
            message_id: messageId,
            executor
          });

          return res.sendStatus(200);
        }

        if (action === 'done') {
          userStates[chatId] = {
            stage: 'awaiting_photo',
            row,
            messageId,
            username,
            serviceMessages: []
          };
          await askForPhoto(chatId);
          return res.sendStatus(200);
        }

        if (action === 'delayed' || action === 'cancel') {
          await axios.post(GAS_WEB_APP_URL, {
            action,
            row,
            executor: username
          });
          const statusText = action === 'delayed' ? '⏳ Ожидает поставки' : '❌ Отменена';
          const updated = `${message.text}\n\n📌 Статус: ${statusText}\n👤 Исполнитель: ${username}`;
          await editMessageText(chatId, messageId, updated);
          return res.sendStatus(200);
        }
      }

      if (body.message) {
        const chatId = body.message.chat.id;
        const text = body.message.text;
        const userMessageId = body.message.message_id;
        const state = userStates[chatId];

        if (!state) return res.sendStatus(200);
        state.lastUserMessageId = userMessageId;

        if (state.stage === 'awaiting_executor_name') {
          const executor = text.trim();
          await axios.post(GAS_WEB_APP_URL, { action: 'markInProgress', row: state.row, executor });
          const updatedText = `${state.originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
          await editMessageText(chatId, state.messageId, updatedText, buildFollowUpButtons(state.row));
          await sendMessage(chatId, `✅ Заявка #${state.row} принята в работу исполнителем ${executor}`, {
            reply_to_message_id: state.messageId
          });
          delete userStates[chatId];
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_photo' && body.message.photo) {
          const fileId = body.message.photo.slice(-1)[0].file_id;
          const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
          const fileUrl = `${TELEGRAM_FILE_API}/${fileRes.data.result.file_path}`;
          state.photo = fileUrl;
          state.stage = 'awaiting_sum';
          await askForSum(chatId);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_sum') {
          if (!/^\d+$/.test(text.trim())) {
            await sendMessage(chatId, '❗ Введите сумму только цифрами.');
            return res.sendStatus(200);
          }
          state.sum = text.trim();
          state.stage = 'awaiting_comment';
          const commentMsgId = await sendMessage(chatId, '✏️ Введите комментарий к выполненной заявке:');
          userStates[chatId].serviceMessages.push(commentMsgId);
          return res.sendStatus(200);
        }

        if (state.stage === 'awaiting_comment') {
          const comment = text.trim();
          const { row, photo, sum, username, messageId, serviceMessages } = state;

          const { data: { result } } = await axios.post(GAS_WEB_APP_URL, {
            action: 'updateAfterCompletion',
            row,
            photoUrl: photo,
            sum,
            comment,
            executor: username,
            message_id: messageId
          });

          const updatedText = `📌 Заявка #${row} закрыта.\n\n` +
            `📍 Пиццерия: ${result.branch}\n` +
            `📋 Проблема: ${result.problem}\n` +
            `💬 Комментарий: ${comment}\n` +
            `📎 Фото: <a href=\"${photo}\">ссылка</a>\n` +
            `💰 Сумма: ${sum} сум\n` +
            `👤 Исполнитель: ${username}\n` +
            `✅ Статус: Выполнено\n` +
            `⏱ Просрочка: ${result.delay || 0} дн.`;

          await editMessageText(chatId, messageId, updatedText, { inline_keyboard: [] });

          setTimeout(async () => {
            try {
              const driveUrlRes = await axios.post(GAS_WEB_APP_URL, {
                action: 'getDrivePhotoUrl', row
              });
              const drivePhoto = driveUrlRes.data.url;
              const replacedText = updatedText.replace(/<a href=.*?>ссылка<\/a>/, `<a href=\"${drivePhoto}\">ссылка</a>`);
              await editMessageText(chatId, messageId, replacedText, { inline_keyboard: [] });
            } catch (err) {
              console.error('❌ Ошибка при обновлении ссылки на Диск:', err);
            }
          }, 60000);

          // Удаляем только сервисные сообщения, НЕ финальное сообщение
          setTimeout(() => {
            const messagesToDelete = [...(serviceMessages || [])];
            if (state.lastUserMessageId) messagesToDelete.push(state.lastUserMessageId);
            messagesToDelete.forEach(msgId => {
              axios.post(`${TELEGRAM_API}/deleteMessage`, {
                chat_id: chatId,
                message_id: msgId
              }).catch(() => {});
            });
          }, 20000);

          delete userStates[chatId];
          return res.sendStatus(200);
        }
      }

      res.sendStatus(200);
    } catch (e) {
      console.error('❌ Ошибка обработки webhook:', e);
      res.sendStatus(500);
    }
  });
};
