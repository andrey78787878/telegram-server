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

  async function handlePhoto(chatId, photo, state) {
    try {
      // Получаем информацию о файле
      const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${photo[photo.length - 1].file_id}`);
      const filePath = fileRes.data.result.file_path;
      const photoUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      
      // Отправляем фото и данные в GAS
      await axios.post(GAS_WEB_APP_URL, {
        action: 'complete',
        row: state.row,
        photoUrl: photoUrl,
        message_id: state.originalMessageId
      });

      // Обновляем сообщение о завершении
      const [originalTextRes] = await axios.post(GAS_WEB_APP_URL, {
        action: 'getRequestText',
        row: state.row
      });
      
      const originalText = originalTextRes.data?.text || '';
      const updatedText = `${originalText}\n\n<b>✅ Выполнено</b>\n👷 <b>Исполнитель:</b> ${state.executor}\n📸 <b>Фото приложено</b>`;

      await editMessageText(chatId, state.originalMessageId, updatedText, { inline_keyboard: [] });

      // Удаляем сервисные сообщения
      if (state.serviceMessages && state.serviceMessages.length > 0) {
        await Promise.all(state.serviceMessages.map(msgId => 
          deleteMessage(chatId, msgId, state.originalMessageId).catch(console.error)
        );
      }

      // Очищаем состояние
      delete userStates[chatId];
      
      console.log('✅ Заявка успешно завершена с фото');
    } catch (error) {
      console.error('❌ Ошибка при обработке фото:', error);
      await sendMessage(chatId, '⚠️ Произошла ошибка при обработке фото. Попробуйте еще раз.');
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
          if (!userStates[chatId]) userStates[chatId] = {};

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
              action: 'getRequestText',
              row
            })
          ]);

          console.log('📩 Ответ от GAS:', originalIdRes.data, originalTextRes.data);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

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
          await editMessageText(chatId, originalMessageId, updatedText, buttons);

          if (originalMessageId !== messageId) {
            await editMessageText(chatId, messageId, message.text, { inline_keyboard: [] });
          }

          userStates[chatId] = {
            ...userStates[chatId],
            executor,
            sourceMessageId: originalMessageId,
            originalMessageId
          };

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
            ...(userStates[chatId] || {}),
            row,
            stage: 'awaiting_photo',
            messageId,
            sourceMessageId: originalMessageId,
            originalMessageId,
            serviceMessages: []
          };

          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения.', {
            reply_to_message_id: originalMessageId
          });
          userStates[chatId].serviceMessages.push(prompt);

          await editMessageText(chatId, originalMessageId, '📌 Выполняется, ожидаем фото...', { inline_keyboard: [] });

          return res.sendStatus(200);
        }

        if (action === 'delayed') {
          // Обработка статуса "Ожидает поставки"
          await axios.post(GAS_WEB_APP_URL, { action: 'delayed', row });
          const updatedText = `${message.text}\n\n<b>⏳ Ожидает поставки</b>`;
          await editMessageText(chatId, messageId, updatedText, { inline_keyboard: [] });
          return res.sendStatus(200);
        }

        if (action === 'cancelled') {
          // Обработка отмены
          await axios.post(GAS_WEB_APP_URL, { action: 'cancelled', row });
          const updatedText = `${message.text}\n\n<b>❌ Отменено</b>`;
          await editMessageText(chatId, messageId, updatedText, { inline_keyboard: [] });
          return res.sendStatus(200);
        }
      }

      if (body.message) {
        const { chat, message_id, text, photo, from } = body.message;
        const chatId = chat.id;
        const state = userStates[chatId];

        console.log('📥 Получено сообщение:', { text, photo: !!photo, state: state?.stage });

        // Обработка ручного ввода исполнителя
        if (state?.awaiting_manual_executor) {
          const executor = text;
          const row = state.row;
          
          console.log('📡 Запрашиваем данные у GAS для ручного исполнителя');
          const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = originalIdRes.data?.message_id;
          const originalText = originalTextRes.data?.text || '';

          if (!originalMessageId) {
            console.error(`❌ GAS не вернул message_id для строки ${row}`);
            return res.sendStatus(200);
          }

          console.log('📤 Отправляем статус "В работе" в GAS с ручным исполнителем');
          await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row, 
            executor, 
            message_id: originalMessageId 
          });

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

          await editMessageText(chatId, originalMessageId, updatedText, buttons);

          // Удаляем сервисные сообщения
          if (state.serviceMessages && state.serviceMessages.length > 0) {
            await Promise.all(state.serviceMessages.map(msgId => 
              deleteMessage(chatId, msgId, originalMessageId).catch(console.error)
            ));
          }

          userStates[chatId] = {
            ...state,
            executor,
            sourceMessageId: originalMessageId,
            originalMessageId,
            awaiting_manual_executor: false
          };

          return res.sendStatus(200);
        }

        // Обработка фото выполнения
        if (state?.stage === 'awaiting_photo' && photo) {
          console.log('📸 Получено фото выполнения');
          await handlePhoto(chatId, photo, state);
          return res.sendStatus(200);
        }

        // Обработка текстового сообщения (если ожидается фото, но прислано не фото)
        if (state?.stage === 'awaiting_photo' && text) {
          await sendMessage(chatId, 'Пожалуйста, пришлите фото выполнения работы.');
          return res.sendStatus(200);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.sendStatus(500);
    }
  });
};
