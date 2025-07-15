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

  function buildFinalButtons(row) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Выполнено', callback_data: `done:${row}` },
          { text: '⏳ Ожидает поставки', callback_data: `delayed:${row}` },
          { text: '❌ Отмена', callback_data: `cancelled:${row}` }
        ]
      ]
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
      await axios.post(`${TELEGRAM_API}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        ...(reply_markup && { reply_markup })
      });
    } catch (error) {
      const desc = error.response?.data?.description || error.message;
      if (!desc.includes('message is not modified')) {
        console.error(`❌ Ошибка изменения сообщения ${messageId}:`, desc);
      }
    }
  }

  async function deleteMessage(chatId, msgId) {
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, {
        chat_id: chatId,
        message_id: msgId
      });
    } catch (e) {
      console.warn(`⚠️ Не удалось удалить сообщение ${msgId}:`, e.message);
    }
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function deleteMessageWithDelay(chatId, msgId, delayMs = 15000) {
    await delay(delayMs);
    await deleteMessage(chatId, msgId);
  }

  async function getFileLink(fileId) {
    const file = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = file.data.result.file_path;
    return `${TELEGRAM_FILE_API}/${filePath}`;
  }

  async function cleanupMessages(chatId, state) {
    const messages = [...(state.serviceMessages || []), ...(state.userResponses || [])];
    for (const msg of messages) {
      await deleteMessage(chatId, msg);
    }
  }

  async function completeRequest(chatId, state, commentMessageId, commentText) {
    let { row, executor, amount, photoUrl } = state;
    const comment = commentText || '';

    if (!row) {
      console.warn('⚠️ Row (номер строки) не найден в state. Пробуем восстановить...');
      const recovery = await axios.post(GAS_WEB_APP_URL, {
        action: 'recoverRowByMessageId',
        message_id: state.originalMessageId
      });
      if (recovery.data?.row) {
        row = recovery.data.row;
        state.row = row;
      } else {
        console.error('❌ Ошибка: не удалось восстановить номер строки.');
        return;
      }
    }

    const [idRes, textRes, delayRes] = await Promise.all([
      axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getDelayInfo', row })
    ]);

    const originalMessageId = idRes.data?.message_id;
    const originalText = textRes.data?.text || '';
    const delayDays = delayRes.data?.delay || '0';

    if (!originalMessageId) {
      console.warn(`⚠️ Нет originalMessageId для строки ${row}, но продолжаем без обновления сообщения.`);
    } else {
      const updatedText = `✅ Выполнено\n👷 Исполнитель: ${executor}\n💰 Сумма: ${amount || '0'}\n📸 Фото: <a href="${photoUrl}">ссылка</a>\n📝 Комментарий: ${comment || 'не указан'}\n🔴 Просрочка: ${delayDays} дн.\n\n━━━━━━━━━━━━\n\n${originalText}`;
      await editMessageText(chatId, originalMessageId, updatedText);
    }

    await axios.post(GAS_WEB_APP_URL, {
      action: 'complete',
      row,
      status: 'Выполнено',
      photoUrl,
      amount,
      comment,
      message_id: originalMessageId || null
    });

    await deleteMessageWithDelay(chatId, commentMessageId);
    await cleanupMessages(chatId, state);
    delete userStates[chatId];

    setTimeout(async () => {
      const finalRes = await axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row });
      const finalText = finalRes.data?.text || originalText;
      const driveUrlRes = await axios.post(GAS_WEB_APP_URL, { action: 'getDriveLink', row });
      const driveUrl = driveUrlRes.data?.driveUrl || photoUrl;
      if (originalMessageId) {
        const editedFinalText = `✅ Выполнено\n👷 Исполнитель: ${executor}\n💰 Сумма: ${amount || '0'}\n📸 Фото: <a href="${driveUrl}">ссылка</a>\n📝 Комментарий: ${comment || 'не указан'}\n🔴 Просрочка: ${delayDays} дн.\n\n━━━━━━━━━━━━\n\n${finalText}`;
        await editMessageText(chatId, originalMessageId, editedFinalText);
      }
    }, 180000);
  }

  // остальная логика webhook продолжится ниже, если понадобится
};
