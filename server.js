app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    // === 1. Обработка нажатий на кнопки (callback_query)
    if (body.callback_query) {
      console.log('➡️ Получен callback_query:', body.callback_query);

      const dataRaw = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + (body.callback_query.from.username || body.callback_query.from.first_name);

      // --- Если кнопка: выбор исполнителя
      if (dataRaw.startsWith('select_executor:')) {
  const parts = dataRaw.split(':');
  const row = parts[1];
  const executor = parts[2];

  if (!row || !executor) {
    console.warn("⚠️ Неверный формат select_executor:", dataRaw);
    return res.sendStatus(200);
  }

  console.log(`👤 Выбран исполнитель ${executor} для заявки #${row}`);

  await axios.post(GAS_WEB_APP_URL, {
    data: {
      action: 'markInProgress',
      row,
      executor
    }
  });
require('dotenv').config();
console.log('GAS_WEB_APP_URL:', process.env.GAS_WEB_APP_URL);

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Telegram API setup
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = "https://api.telegram.org/bot" + BOT_TOKEN;

const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

// In-memory user state for multi-step flows
const userStates = {};

// Buttons for follow-up actions
const buildFollowUpButtons = row => ({
  inline_keyboard: [[
    { text: 'Выполнено ✅', callback_data: JSON.stringify({ action: 'completed', row }) },
    { text: 'Ожидает поставки ⏳', callback_data: JSON.stringify({ action: 'delayed', row }) },
    { text: 'Отмена ❌', callback_data: JSON.stringify({ action: 'cancelled', row }) },
  ]]
});

// List of executors and buttons for selection
const EXECUTORS = ['@EvelinaB87','@Olim19','@Oblayor_04_09','Текстовой подрядчик'];
const buildExecutorButtons = row => ({
  inline_keyboard: EXECUTORS.map(ex => [
    { text: ex, callback_data: JSON.stringify({ action: 'select_executor', row, executor: ex }) }
  ])
});

// Helpers for Telegram
async function sendMessage(chatId, text, options = {}) {
  try {
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML', ...options });
    return res.data.result.message_id;
  } catch (e) {
    console.error('Ошибка отправки:', e.response?.data || e.message);
  }
}

async function editMessageText(chatId, messageId, text, reply_markup) {
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup
    });
  } catch (e) {
    console.error('Ошибка редактирования:', e.response?.data || e.message);
  }
}

// Multi-step prompts
async function askForPhoto(chatId) {
  const msgId = await sendMessage(chatId, '📸 Пришлите ссылку на Telegram-фото выполненных работ.');
  if (!userStates[chatId]) userStates[chatId] = {};
  if (!userStates[chatId].serviceMessages) userStates[chatId].serviceMessages = [];
  userStates[chatId].serviceMessages.push(msgId);
}
async function askForSum(chatId) {
  const msgId = await sendMessage(chatId, '💰 Введите сумму работ в сумах (только цифры).');
  userStates[chatId].serviceMessages.push(msgId);
}
async function askForComment(chatId) {
  const msgId = await sendMessage(chatId, '💬 Добавьте комментарий к заявке.');
  userStates[chatId].serviceMessages.push(msgId);
}

// Webhook
app.post('/callback', async (req, res) => {
  console.log('📥 Webhook получен:', JSON.stringify(req.body, null, 2));
  try {
    const body = req.body;

    if (body.callback_query) {
      const { data: raw, message, from } = body.callback_query;
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const username = '@' + (from.username || from.first_name);
      let data;
      try { data = JSON.parse(raw); } catch { return res.sendStatus(200); }
      const { action, row, executor } = data;

      if (action === 'in_progress' && row) {
        await editMessageText(chatId, messageId, `Выберите исполнителя для заявки #${row}:`, buildExecutorButtons(row));
        return res.sendStatus(200);
      }

      if (action === 'select_executor' && row && executor) {
        await axios.post(GAS_WEB_APP_URL, { data: { action: 'markInProgress', row, executor } });
        const newText = `${message.text}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
        await editMessageText(chatId, messageId, newText, buildFollowUpButtons(row));
        await sendMessage(chatId, `✅ Заявка #${row} принята в работу исполнителем ${executor}`, { reply_to_message_id: messageId });
        return res.sendStatus(200);
      }

      if (action === 'completed' && row) {
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username, serviceMessages: [] };
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      if ((action === 'delayed' || action === 'cancelled') && row) {
        await axios.post(GAS_WEB_APP_URL, { data: { action, row, executor: username } });
        const status = action === 'delayed' ? 'Ожидает поставки' : 'Отменена';
        const updated = `${message.text}\n\n📌 Статус: ${status}\n👤 Исполнитель: ${username}`;
        await editMessageText(chatId, messageId, updated);
        return res.sendStatus(200);
      }
    }

    if (body.message) {
      const chatId = body.message.chat.id;
      const state = userStates[chatId]; if (!state) return res.sendStatus(200);
      const text = body.message.text;
      const userMessageId = body.message.message_id;
      state.lastUserMessageId = userMessageId;

      if (state.stage === 'awaiting_photo' && text) {
        state.photo = text.trim();
        state.stage = 'awaiting_sum';
        await askForSum(chatId);
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_sum' && text) {
        if (!/^\d+$/.test(text.trim())) {
          await sendMessage(chatId, '❗ Введите сумму только цифрами.');
          return res.sendStatus(200);
        }
        state.sum = text.trim();
        state.stage = 'awaiting_comment';
        await askForComment(chatId);
        return res.sendStatus(200);
      }

      if (state.stage === 'awaiting_comment' && text) {
        const comment = text.trim();
        const { row, photo, sum, username, messageId, serviceMessages } = state;

        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'updateAfterCompletion',
            row,
            photoUrl: photo,
            sum,
            comment,
            executor: username,
            message_id: messageId
          }
        });

        const updatedText =
          `📌 Заявка №${row} закрыта.\n\n` +
          `📎 Фото: <a href="${photo}">ссылка</a>\n` +
          `💰 Сумма: ${sum} сум\n` +
          `👤 Исполнитель: ${username}\n` +
          `✅ Статус: Выполнено\n`;

        await sendMessage(chatId, `📌 Заявка №${row} закрыта.`, { reply_to_message_id: messageId });
        await editMessageText(chatId, messageId, updatedText, { inline_keyboard: [] });

        setTimeout(async () => {
          try {
            for (const msgId of serviceMessages) {
              await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: msgId }).catch(() => {});
            }
            if (state.lastUserMessageId) {
              await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: state.lastUserMessageId }).catch(() => {});
            }
          } catch (err) {
            console.error('Ошибка удаления сообщений:', err.message);
          }
        }, 60000);

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

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
