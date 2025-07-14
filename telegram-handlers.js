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
    console.log(`📤 Отправлено сообщение: ${text}`);
    return res.data.result.message_id;
  }

  async function editMessageText(chatId, messageId, text, reply_markup) {
    try {
      const updatedText = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      console.log(`📝 Пытаемся изменить сообщение ${messageId}`);
      console.log('➡️ Новый текст:', updatedText);
      console.log('➡️ Новые кнопки:', JSON.stringify(reply_markup, null, 2));

      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text: updatedText,
        parse_mode: 'HTML',
        ...(reply_markup && { reply_markup })
      });
      console.log(`✏️ Изменено сообщение ${messageId} в чате ${chatId}`);
    } catch (error) {
      const desc = error.response?.data?.description || error.message;
      if (desc.includes('message is not modified')) {
        console.log(`ℹ️ Сообщение ${messageId} не изменено (тот же текст/markup)`);
      } else {
        console.error(`❌ Ошибка изменения сообщения ${messageId}:`, error.response?.data || error.message);
      }
    }
  }

  async function deleteMessage(chatId, msgId, finalId) {
    if (msgId === finalId) return;
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
      console.log(`🗑️ Удалено сообщение: ${msgId}`);
    } catch (e) {
      console.warn(`⚠️ Не удалось удалить сообщение ${msgId}:`, e.message);
    }
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      if (body.callback_query) {
        const { data: raw, message, from, id: callbackId } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const username = '@' + (from.username || from.first_name);

        try {
          await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackId });
        } catch (err) {
          console.error("❌ Ошибка при ответе на callback_query:", err.message);
        }

        const parts = raw.split(':');
        const action = parts[0];
        const row = parts[1];
        const executor = parts[2];

        console.log(`➡️ Callback: ${action}, row: ${row}, executor: ${executor}`);

        if (action === 'in_progress') {
          console.log('🧼 Удаляем кнопку "Принято в работу"');
          await editMessageText(chatId, messageId, message.text, { inline_keyboard: [] });

          console.log('🧱 Показываем кнопки выбора исполнителя');
          const keyboard = buildExecutorButtons(row);
          const newText = message.text + '\n\nВыберите исполнителя:';
          await editMessageText(chatId, messageId, newText, keyboard);

          userStates[chatId] = { row, sourceMessageId: messageId, serviceMessages: [] };
          return res.sendStatus(200);
        }

        if (action === 'select_executor') {
          if (!userStates[chatId]) return res.sendStatus(200);

          if (executor === 'Текстовой подрядчик') {
            userStates[chatId].awaiting_manual_executor = true;
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика вручную:', {
              reply_to_message_id: userStates[chatId].sourceMessageId
            });
            userStates[chatId].serviceMessages.push(prompt);
            return res.sendStatus(200);
          }

          console.log(`👤 Выбран исполнитель: ${executor}`);

          console.log('📡 Запрашиваем данные у GAS');
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, {
              action: 'getMessageId',
              row
            }),
            axios.post(GAS_WEB_APP_URL, {
              action: 'getOriginalText',
              row
            })
          ]);

          console.log('📩 Ответ от GAS:', originalIdRes.data, originalTextRes.data);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.originalText || '';

          if (!originalMessageId) {
            console.error(`❌ GAS не вернул message_id для строки ${row}:`, originalIdRes.data);
            return res.sendStatus(200);
          }

          console.log('📤 Отправляем статус "В работе" в GAS');
          await axios.post(GAS_WEB_APP_URL, { action: 'in_progress', row, executor, message_id: originalMessageId });

          const updatedText = `${originalText}\n\n<b>🟢 В работе</b>\n👷 <b>Исполнитель:</b> ${executor}`;

          const buttons = {
            inline_keyboard: [
              [
                { text: 'Выполнено ✅', callback_data: `done:${row}` },
                { text: 'Ожидает поставки ⏳', callback_data: `delayed:${row}` },
                { text: 'Отмена ❌', callback_data: `cancelled:${row}` }
              ]
            ]
          };

          console.log('✏️ Обновляем исходное сообщение с кнопками');
          console.log('➡️ updatedText:', updatedText);
          console.log('➡️ buttons:', JSON.stringify(buttons, null, 2));

          await editMessageText(chatId, originalMessageId, updatedText, buttons);

          if (originalMessageId !== messageId) {
            await editMessageText(chatId, messageId, message.text, { inline_keyboard: [] });
          }

          userStates[chatId].executor = executor;
          userStates[chatId].sourceMessageId = originalMessageId;
          userStates[chatId].originalMessageId = originalMessageId;
          return res.sendStatus(200);
        }

        if (action === 'done') {
          const originalIdRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getMessageId',
            row
          });
          const originalMessageId = originalIdRes.data?.message_id;

          if (!originalMessageId) {
            console.error(`❌ Не найден originalMessageId для строки ${row}`);
            return res.sendStatus(200);
          }

          userStates[chatId] = {
            row,
            stage: 'awaiting_photo',
            messageId,
            serviceMessages: [],
            sourceMessageId: originalMessageId,
            executor: userStates[chatId]?.executor || null,
            originalMessageId
          };

          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения.', {
            reply_to_message_id: originalMessageId
          });
          userStates[chatId].serviceMessages.push(prompt);

          await editMessageText(chatId, originalMessageId, '📌 Выполняется, ожидаем фото...', { inline_keyboard: [] });

          return res.sendStatus(200);
        }
      }

      if (body.message) {
        console.log('📥 Получено обычное сообщение от пользователя');
        // ... остальная часть остаётся без изменений ...
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
