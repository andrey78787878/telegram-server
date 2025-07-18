const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const AUTHORIZED_USERS = [
  '@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB', '@Davr_85'
];

module.exports = (app, userStates) => {
  app.post('/webhook', async (req, res) => {
    const body = req.body;

    const { message, callback_query } = body;
    const data = callback_query?.data;
    const msg = callback_query?.message;
    const from = callback_query?.from;

    if (!callback_query || !msg || !data || !from) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const username = from.username ? `@${from.username}` : null;

    // Проверка доступа
    if (!AUTHORIZED_USERS.includes(username)) {
      await sendMessage(chatId, '❌ У вас нет доступа.');
      return res.sendStatus(200);
    }

    const row = extractRowFromMessage(msg.text);
    if (!row) return res.sendStatus(200);

    // === Обработка "Принять в работу" ===
    if (data === 'accept') {
      await editMessage(chatId, messageId, msg.text + `\n\n🟢 Заявка в работе`);

      const buttons = AUTHORIZED_USERS.map(e => [
        { text: e, callback_data: `executor:${e}` }
      ]);

      await sendMessage(chatId, '👷 Выберите исполнителя:', {
        reply_to_message_id: messageId
      });

      await sendButtons(chatId, messageId, buttons);

      return res.sendStatus(200);
    }

    // === Обработка выбора исполнителя ===
    if (data.startsWith('executor:')) {
      const executor = data.split(':')[1];

      await sendToGAS({
        row,
        status: 'В работе',
        executor,
        message_id: messageId,
      });

      await sendButtons(chatId, messageId, [
        [
          { text: '✅ Выполнено', callback_data: 'done' },
          { text: '🕐 Ожидает поставки', callback_data: 'wait' },
          { text: '❌ Отмена', callback_data: 'cancel' },
        ]
      ]);

      return res.sendStatus(200);
    }

    if (data === 'done') {
      userStates[chatId] = { stage: 'waiting_photo', row, username, messageId, serviceMessages: [] };
      await sendMessage(chatId, '📸 Пришлите фото выполненных работ');
      return res.sendStatus(200);
    }

    if (data === 'wait') {
      await sendMessage(chatId, '⏳ Заявка переведена в статус "Ожидает поставки"', { reply_to_message_id: messageId });
      await sendToGAS({ row, status: 'Ожидает поставки' });
      return res.sendStatus(200);
    }

    if (data === 'cancel') {
      await sendMessage(chatId, '🚫 Заявка отменена', { reply_to_message_id: messageId });
      await sendToGAS({ row, status: 'Отменено' });
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  });

  // === USER MESSAGE ===
  app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (!body.message) return res.sendStatus(200);

    const msg = body.message;
    const chatId = msg.chat.id;
    const state = userStates[chatId];

    if (!state) return res.sendStatus(200);

    try {
      if (state.stage === 'waiting_photo' && msg.photo) {
        const fileId = msg.photo.at(-1).file_id;
        const fileLink = await getTelegramFileUrl(fileId);

        state.photoUrl = fileLink;
        state.stage = 'waiting_sum';
        state.serviceMessages.push(msg.message_id);

        await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
        return res.sendStatus(200);
      }

      if (state.stage === 'waiting_sum' && msg.text) {
        state.sum = msg.text;
        state.stage = 'waiting_comment';
        state.serviceMessages.push(msg.message_id);

        await sendMessage(chatId, '💬 Напишите комментарий');
        return res.sendStatus(200);
      }

      if (state.stage === 'waiting_comment' && msg.text) {
        state.comment = msg.text;
        state.serviceMessages.push(msg.message_id);

        const { row, sum, comment, photoUrl, username, messageId } = state;

        await sendToGAS({
          row, sum, comment, photo: photoUrl, status: 'Выполнено', executor: username
        });

        const summary = [
          `📌 Заявка #${row} закрыта.`,
          `📎 Фото: ${photoUrl}`,
          `💰 Сумма: ${sum} сум`,
          `👤 Исполнитель: ${username}`,
          `✅ Статус: Выполнено`,
          `🔄 Ссылка обновится через 3 минуты`,
          `💬 Комментарий: ${comment}`
        ].join('\n');

        await editMessage(chatId, messageId, summary);

        setTimeout(async () => {
          try {
            const diskUrl = await getGoogleDiskLink(row);
            const updatedSummary = [
              `📌 Заявка #${row} закрыта.`,
              `📎 Фото: ${diskUrl}`,
              `💰 Сумма: ${sum} сум`,
              `👤 Исполнитель: ${username}`,
              `✅ Статус: Выполнено`,
              `💬 Комментарий: ${comment}`
            ].join('\n');
            await editMessage(chatId, messageId, updatedSummary);
          } catch (e) {
            console.error('Error updating disk link:', e);
          }
        }, 3 * 60 * 1000);

        setTimeout(async () => {
          try {
            for (const msgId of state.serviceMessages) {
              await deleteMessage(chatId, msgId);
            }
          } catch (e) {
            console.error('Error deleting service messages:', e);
          }
        }, 60 * 1000);

        delete userStates[chatId];
        return res.sendStatus(200);
      }
    } catch (e) {
      console.error('Error handling user message:', e);
      return res.sendStatus(500);
    }

    res.sendStatus(200);
  });
};

// === SUPPORT FUNCTIONS ===

async function sendMessage(chatId, text, options = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options
  });
}

async function editMessage(chatId, messageId, text) {
  return axios.post(`${TELEGRAM_API}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  });
}

async function deleteMessage(chatId, messageId) {
  return axios.post(`${TELEGRAM_API}/deleteMessage`, {
    chat_id: chatId,
    message_id: messageId
  }).catch(() => {});
}

async function sendButtons(chatId, messageId, buttons) {
  return axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function getTelegramFileUrl(fileId) {
  const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return `${TELEGRAM_FILE_API}/${data.result.file_path}`;
}

async function sendToGAS(data) {
  return axios.post(GAS_WEB_APP_URL, data);
}

async function getGoogleDiskLink(row) {
  try {
    const res = await axios.post(`${GAS_WEB_APP_URL}?getDiskLink=true`, { row });
    return res.data.diskLink || '🔗 [файл не найден]';
  } catch {
    return '🔗 [ошибка загрузки ссылки]';
  }
}

function extractRowFromMessage(text) {
  if (!text) return null;
  const match = text.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}


