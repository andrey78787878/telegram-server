// ✅ server.js — полный Telegram бот с подтягиванием заявки из таблицы

require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

const userStates = {}; // временное хранилище состояний

function tg(method, data) {
  return axios.post(`${TELEGRAM_API}/${method}`, data);
}

// === Обработчик вебхука === //
app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    if (body.callback_query) return await handleCallback(body.callback_query, res);
    if (body.message) return await handleMessage(body.message, res);
  } catch (err) {
    console.error('❌ Ошибка в webhook:', err);
  }

  res.sendStatus(200);
});

// === Обработка кнопок === //
async function handleCallback(query, res) {
  const { data, message, from, id } = query;
  const [action, row, extra] = data.split(':');
  const chat_id = message.chat.id;
  const message_id = message.message_id;
  const username = '@' + (from.username || from.first_name);

  await tg('answerCallbackQuery', { callback_query_id: id });

  if (action === 'select_executor') {
    const { data: rowData } = await axios.get(`${GAS_WEB_APP_URL}?get=row&row=${row}`);

    const updated =
      `📌 Заявка #${row}\n\n` +
      `🏬 Пиццерия: ${rowData.pizzeria || '—'}\n` +
      `🛠 Классификация: ${rowData.classification || '—'}\n` +
      `📂 Категория: ${rowData.category || '—'}\n` +
      `📝 Суть: ${rowData.problem || '—'}\n\n` +
      `🟢 В работе\n👷 Исполнитель: ${extra}`;

    const reply_markup = {
      inline_keyboard: [[
        { text: 'Выполнено ✅', callback_data: `done:${row}:${extra}` },
        { text: 'Ожидает поставки ⏳', callback_data: `delayed:${row}:${extra}` },
        { text: 'Отмена ❌', callback_data: `cancel:${row}:${extra}` }
      ]]
    };

    await tg('editMessageText', { chat_id, message_id, text: updated, parse_mode: 'HTML', reply_markup });

    await axios.post(GAS_WEB_APP_URL, {
      data: { action: 'in_progress', row, message_id, executor: extra }
    });

    await tg('sendMessage', {
      chat_id,
      reply_to_message_id: message_id,
      text: `📌 Заявка #${row} принята в работу исполнителем ${extra}`
    });

    return res.sendStatus(200);
  }

  if (action === 'done') {
    userStates[from.id] = {
      step: 'awaiting_photo', row, executor: extra, message_id, chat_id, service: []
    };
    const msg = await tg('sendMessage', {
      chat_id,
      reply_to_message_id: message_id,
      text: '📸 Пришлите фото выполненных работ'
    });
    userStates[from.id].service.push(msg.data.result.message_id);
    return res.sendStatus(200);
  }

  if (action === 'delayed' || action === 'cancel') {
    const status = action === 'delayed' ? 'Ожидает поставки' : 'Отменена';
    const updated = `${message.text}\n\n📌 Статус: ${status}\n👤 Исполнитель: ${extra}`;
    await tg('editMessageText', { chat_id, message_id, text: updated, parse_mode: 'HTML' });

    await axios.post(GAS_WEB_APP_URL, {
      data: { action, row, executor: extra }
    });
    return res.sendStatus(200);
  }
}

// === Обработка сообщений пользователя === //
async function handleMessage(message, res) {
  const { chat, text, photo, from, message_id } = message;
  const state = userStates[from.id];
  if (!state) return res.sendStatus(200);

  const { step, row, executor, chat_id, message_id: masterMsgId, service } = state;

  if (step === 'awaiting_photo' && photo) {
    const file_id = photo.slice(-1)[0].file_id;
    const resFile = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
    const fileUrl = `${TELEGRAM_FILE_API}/${resFile.data.result.file_path}`;
    userStates[from.id].photo = fileUrl;
    userStates[from.id].step = 'awaiting_sum';

    const resp = await tg('sendMessage', {
      chat_id: chat.id,
      text: '💰 Введите сумму (в сумах)'
    });
    service.push(resp.data.result.message_id);
    return res.sendStatus(200);
  }

  if (step === 'awaiting_sum') {
    if (!/^[0-9]+$/.test(text)) {
      await tg('sendMessage', {
        chat_id: chat.id,
        text: '❗ Введите сумму только цифрами'
      });
      return res.sendStatus(200);
    }
    userStates[from.id].sum = text.trim();
    userStates[from.id].step = 'awaiting_comment';

    const resp = await tg('sendMessage', {
      chat_id: chat.id,
      text: '✏️ Введите комментарий к выполненной заявке:'
    });
    service.push(resp.data.result.message_id);
    return res.sendStatus(200);
  }

  if (step === 'awaiting_comment') {
    const comment = text.trim();
    const { photo, sum } = userStates[from.id];

    await axios.post(GAS_WEB_APP_URL, {
      data: {
        action: 'complete', row, photoUrl: photo, sum, comment, executor, message_id: masterMsgId
      }
    });

    const { data: rowData } = await axios.get(`${GAS_WEB_APP_URL}?get=row&row=${row}`);

    const finalText =
      `📌 Заявка #${row} закрыта.\n\n` +
      `🏬 Пиццерия: ${rowData.pizzeria || '—'}\n` +
      `🛠 Классификация: ${rowData.classification || '—'}\n` +
      `📂 Категория: ${rowData.category || '—'}\n` +
      `📝 Суть: ${rowData.problem || '—'}\n\n` +
      `📎 Фото: <a href=\"${photo}\">ссылка</a>\n` +
      `💰 Сумма: ${sum} сум\n` +
      `👤 Исполнитель: ${executor}\n` +
      `✅ Статус: Выполнено\n` +
      `⏰ Просрочка: ${rowData.delay || 0} дн.`;

    await tg('editMessageText', {
      chat_id: chat.id,
      message_id: masterMsgId,
      text: finalText,
      parse_mode: 'HTML'
    });

    await tg('sendMessage', {
      chat_id: chat.id,
      reply_to_message_id: masterMsgId,
      text: `✅ Заявка #${row} закрыта.`
    });

    setTimeout(() => {
      for (const id of [...service, message_id]) {
        tg('deleteMessage', { chat_id: chat.id, message_id: id }).catch(() => {});
      }
    }, 60000);

    delete userStates[from.id];
    return res.sendStatus(200);
  }
}

// === Запуск сервера === //
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
