pp.post('/webhook', async (req, res) => {
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

 // === MAIN WEBHOOK HANDLER === //
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

// === CALLBACK QUERY HANDLER === //
async function handleCallback(query, res) {
  const { data, message, from, id } = query;
  const [action, row, extra] = data.split(':');
  const chat_id = message.chat.id;
  const message_id = message.message_id;
  const username = '@' + (from.username || from.first_name);

  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: id });

  if (action === 'select_executor') {
    const updated = `${message.text}\n\n🟢 В работе\n👷 Исполнитель: ${extra}`;
    const reply_markup = {
      inline_keyboard: [
        [
          { text: 'Выполнено ✅', callback_data: `done:${row}:${extra}` },
          { text: 'Ожидает поставки ⏳', callback_data: `delayed:${row}:${extra}` },
          { text: 'Отмена ❌', callback_data: `cancel:${row}:${extra}` }
        ]
      ]
    };

    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id,
      message_id,
      text: updated,
      parse_mode: 'HTML',
      reply_markup
    });

    await axios.post(GAS_WEB_APP_URL, {
      action: 'in_progress',
      row,
      message_id,
      executor: extra
    });

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
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
    const resp = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id,
      reply_to_message_id: message_id,
      text: '📸 Пришлите фото выполненных работ'
    });
    userStates[from.id].service.push(resp.data.result.message_id);
    return res.sendStatus(200);
  }

  if (action === 'delayed' || action === 'cancel') {
    const status = action === 'delayed' ? 'Ожидает поставки' : 'Отменена';
    const updated = `${message.text}\n\n📌 Статус: ${status}\n👤 Исполнитель: ${extra}`;
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id,
      message_id,
      text: updated,
      parse_mode: 'HTML'
    });

    await axios.post(GAS_WEB_APP_URL, {
      action,
      row,
      executor: extra
    });
    return res.sendStatus(200);
  }
}

// === MESSAGE HANDLER === //
async function handleMessage(message, res) {
  const { chat, text, photo, from, message_id } = message;
  const state = userStates[from.id];
  if (!state) return res.sendStatus(200);

  const { step, row, executor, chat_id, message_id: masterId, service } = state;

  if (step === 'awaiting_photo' && photo) {
    const file_id = photo.slice(-1)[0].file_id;
    const resFile = await axios.get(`${TELEGRAM_API}/getFile?file_id=${file_id}`);
    const fileUrl = `${TELEGRAM_FILE_API}/${resFile.data.result.file_path}`;
    userStates[from.id].photo = fileUrl;
    userStates[from.id].step = 'awaiting_sum';

    const resp = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chat.id,
      text: '💰 Введите сумму (в сумах)'
    });
    service.push(resp.data.result.message_id);
    return res.sendStatus(200);
  }

  if (step === 'awaiting_sum') {
    if (!/^\d+$/.test(text)) {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chat.id,
        text: '❗ Введите сумму только цифрами'
      });
      return res.sendStatus(200);
    }
    userStates[from.id].sum = text.trim();
    userStates[from.id].step = 'awaiting_comment';

    const resp = await axios.post(`${TELEGRAM_API}/sendMessage`, {
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
      action: 'complete',
      row,
      photo,
      sum,
      comment,
      executor,
      message_id: masterId
    });

    const final = await axios.post(`${GAS_WEB_APP_URL}?get=final`, { row });
    const { delay, driveLink } = final.data;

    const updated = `📍 Заявка #${row} ✅ Статус: Выполнено\n\n📋 Комментарий: ${comment}\n🍕 Пиццерия: ...\n🔧 Классификация: ...\n📂 Категория: ...\n👤 Инициатор: ...\n📞 Тел: ...\n🕓 Просрочка: ${delay} дн.\n📎 Фото: ${driveLink}\n💰 Сумма: ${sum} сум\n👤 Исполнитель: ${executor}`;

    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chat.id,
      message_id: masterId,
      text: updated,
      parse_mode: 'HTML'
    });

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chat.id,
      reply_to_message_id: masterId,
      text: `✅ Заявка #${row} закрыта.`
    });

    setTimeout(() => {
      for (const id of [...service, message_id]) {
        axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chat.id, message_id: id }).catch(() => {});
      }
    }, 60000);

    delete userStates[from.id];
    return res.sendStatus(200);
  }
}

// === START SERVER === //
app.listen(PORT, () => {
  console.log(`🚀 Bot server running on port ${PORT}`);
});

    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
