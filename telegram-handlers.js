// telegram-handlers.js
module.exports = (app, userStates) => {
  const axios = require('axios');
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
  const AUTHORIZED_USERS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB'];

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
    let { row, executor, amount, photoUrl, originalMessageId } = state;
    const comment = commentText || '';

    if (!row) {
      const recovery = await axios.post(GAS_WEB_APP_URL, {
        action: 'recoverRowByMessageId',
        message_id: originalMessageId
      });
      if (recovery.data?.row) {
        row = recovery.data.row;
        state.row = row;
      } else {
        console.error('❌ Не удалось восстановить номер строки.');
        return;
      }
    }

    const [idRes, textRes, delayRes, driveUrlRes, commentRes] = await Promise.all([
      axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getDelayInfo', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getDriveLink', row }),
      axios.post(GAS_WEB_APP_URL, { action: 'getExecutorComment', row })
    ]);

// 1. Сначала записываем результат в таблицу
await axios.post(GAS_WEB_APP_URL, {
  action: 'complete',
  row,
  photoUrl,
  amount,
  comment,
  completed_at: new Date().toISOString(),
  message_id: resolvedMessageId
});

// 2. Затем получаем обновлённые данные для финального сообщения
const [idRes, textRes, delayRes, driveUrlRes, commentRes] = await Promise.all([
  axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
  axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row }),
  axios.post(GAS_WEB_APP_URL, { action: 'getDelayInfo', row }),
  axios.post(GAS_WEB_APP_URL, { action: 'getDriveLink', row }),
  axios.post(GAS_WEB_APP_URL, { action: 'getExecutorComment', row })
]);

const resolvedMessageId = idRes.data?.message_id;
const originalText = textRes.data?.text || '';
const delayDays = delayRes.data?.delay || '0';
const driveUrl = driveUrlRes.data?.driveUrl || photoUrl;
const commentR = commentRes.data?.comment || '';
const updatedText = `📌 Заявка #${row} закрыта.\n📎 Фото: <a href="${driveUrl}">ссылка</a>\n💰 Сумма: ${amount || '0'} сум\n👤 Исполнитель: ${executor}\n✅ Статус: Выполнено\n🔴 Просрочка: ${delayDays} дн.\n\n💬 Комментарий: ${commentR}\n\n━━━━━━━━━━━━\n\n${originalText}`;

if (resolvedMessageId) {
  await editMessageText(chatId, resolvedMessageId, updatedText);
  state.originalMessageId = resolvedMessageId;
}


    setTimeout(async () => {
      try {
        const driveUpdateRes = await axios.post(GAS_WEB_APP_URL, {
          action: 'getDriveLink',
          row
        });
        const updatedDriveUrl = driveUpdateRes.data?.driveUrl;

        if (updatedDriveUrl && updatedDriveUrl !== driveUrl) {
          const refreshedText = `📌 Заявка #${row} закрыта.\n📎 Фото: <a href="${updatedDriveUrl}">ссылка</a>\n💰 Сумма: ${amount || '0'} сум\n👤 Исполнитель: ${executor}\n✅ Статус: Выполнено\n🔴 Просрочка: ${delayDays} дн.\n\n💬 Комментарий: ${commentR}\n\n━━━━━━━━━━━━\n\n${originalText}`;
          await editMessageText(chatId, resolvedMessageId, refreshedText);
        }
      } catch (err) {
        console.warn('⚠️ Ошибка обновления ссылки на Google Диск:', err.message);
      }
    }, 3 * 60 * 1000);

    await deleteMessageWithDelay(chatId, commentMessageId);
    await cleanupMessages(chatId, state);
    delete userStates[chatId];
  }

  app.post('/webhook', async (req, res) => {
    try {
      const body = req.body;

      if (body.message) {
        const msg = body.message;
        const chatId = msg.chat.id;
        const state = userStates[chatId];
if (msg.text && msg.text.toLowerCase().startsWith('/сводка')) {
  try {
    const summaryRes = await axios.post(GAS_WEB_APP_URL, { action: 'getGroupedSummary' });
    const summary = summaryRes.data;

    let report = '<b>📊 Сводка по заявкам</b>\n\n';
    const sections = {
      notAccepted: '🆕 <b>Не приняты</b>',
      inProgress: '🔧 <b>В работе</b>',
      overdue: '⏰ <b>Просрочены</b>'
    };

    for (const key of Object.keys(sections)) {
      const block = summary[key];
      if (block && Object.keys(block).length > 0) {
        report += `${sections[key]}:\n`;
        for (const pizzeria in block) {
          const items = block[pizzeria].join(', ');
          report += `🍕 ${pizzeria}: ${items}\n`;
        }
        report += '\n';
      }
    }

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: report,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('❌ Ошибка получения сводки:', err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: '⚠️ Не удалось получить сводку.',
    });
  }

  return res.sendStatus(200);
}



        if (state?.stage === 'awaiting_photo' && msg.photo) {
          const photo = msg.photo[msg.photo.length - 1];
          const fileLink = await getFileLink(photo.file_id);
          state.photoUrl = fileLink;
          state.stage = 'awaiting_amount';
          const prompt = await sendMessage(chatId, '💰 Введите сумму:');
          state.serviceMessages.push(prompt);
          state.userResponses.push(msg.message_id);
          return res.sendStatus(200);
        }

        if (state?.stage === 'awaiting_amount' && msg.text) {
          state.amount = msg.text.trim();
          state.stage = 'awaiting_comment';
          const prompt = await sendMessage(chatId, '✏️ Введите комментарий:');
          state.serviceMessages.push(prompt);
          state.userResponses.push(msg.message_id);
          return res.sendStatus(200);
        }

        if (state?.stage === 'awaiting_comment' && msg.text) {
          state.userResponses.push(msg.message_id);
          await completeRequest(chatId, state, msg.message_id, msg.text);
          return res.sendStatus(200);
        }
      }

      if (body.callback_query) {
        const { data: raw, message, id: callbackId, from } = body.callback_query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const [action, row, executor] = raw.split(':');
        const username = from.username ? `@${from.username}` : '';

        if (!AUTHORIZED_USERS.includes(username)) {
          await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: callbackId,
            text: '⛔️ У вас нет прав на выполнение этого действия.',
            show_alert: true
          });
          return res.sendStatus(200);
        }

        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackId });

        if (action === 'in_progress') {
          const keyboard = buildExecutorButtons(row);
          await editMessageText(chatId, messageId, `${message.text}\n\nВыберите исполнителя:`, keyboard);
          userStates[chatId] = { row, originalMessageId: messageId, serviceMessages: [] };
          return res.sendStatus(200);
        }

        if (action === 'select_executor') {
          if (!userStates[chatId]) userStates[chatId] = {};
          userStates[chatId].row = row;
          userStates[chatId].executor = executor;

          if (executor === 'Текстовой подрядчик') {
            const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
            userStates[chatId].awaiting_manual_executor = true;
            userStates[chatId].serviceMessages = [prompt];
            return res.sendStatus(200);
          }

          const [idRes, textRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
          ]);

          const originalMessageId = idRes.data?.message_id;
          const originalText = textRes.data?.text || '';

          await axios.post(GAS_WEB_APP_URL, {
            action: 'in_progress',
            row,
            executor,
            message_id: originalMessageId
          });

          const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
          const buttons = buildFinalButtons(row);
          await editMessageText(chatId, originalMessageId, updatedText, buttons);

          userStates[chatId] = {
            ...userStates[chatId],
            row,
            executor,
            originalMessageId,
            serviceMessages: []
          };

          return res.sendStatus(200);
        }

        if (action === 'done') {
          if (!userStates[chatId]) {
            console.warn('⚠️ Нет состояния для пользователя.');
            return res.sendStatus(200);
          }

          userStates[chatId] = {
            ...userStates[chatId],
            stage: 'awaiting_photo',
            serviceMessages: [],
            userResponses: []
          };

          const prompt = await sendMessage(chatId, '📸 Пришлите фото выполнения:');
          userStates[chatId].serviceMessages.push(prompt);
          deleteMessageWithDelay(chatId, prompt);
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
