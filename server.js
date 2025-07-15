require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// 🔐 Переменные окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// ✅ Проверка переменных
if (!BOT_TOKEN || !GAS_WEB_APP_URL || !TELEGRAM_CHAT_ID || !WEBHOOK_URL) {
  console.error('❌ Не хватает переменных среды! Проверь .env файл.');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const userStates = {};

// ✅ Установка вебхука
async function setTelegramWebhook() {
  try {
    const res = await axios.get(`${TELEGRAM_API}/setWebhook?url=${WEBHOOK_URL}`);
    console.log('✅ Вебхук установлен:', res.data);
  } catch (err) {
    console.error('❌ Ошибка установки вебхука:', err.response?.data || err.message);
  }
}

// 🔁 Проверка отложенных заявок
async function checkPendingRequestsAndSend() {
  try {
    const res = await axios.post(GAS_WEB_APP_URL, { action: 'getPendingMessages' });
    const pending = res.data;

    if (!pending || !Array.isArray(pending) || pending.length === 0) {
      console.log('ℹ️ Нет заявок для отправки.');
      return;
    }

    for (const rowObj of pending) {
      const {
        row, pizzaria, classif, category, problem,
        initiator, phone, deadline
      } = rowObj;

      const message = `📍 <b>Заявка #${row}</b>\n\n🍕 <b>Пиццерия:</b> ${pizzaria}\n🔧 <b>Классификация:</b> ${classif}\n📂 <b>Категория:</b> ${category}\n📋 <b>Проблема:</b> ${problem}\n👤 <b>Инициатор:</b> ${initiator}\n📞 <b>Тел:</b> ${phone}\n🕓 <b>Срок:</b> ${deadline}`;

      const keyboard = {
        inline_keyboard: [
          [{ text: 'Принять в работу 🟢', callback_data: `in_progress:${row}` }]
        ]
      };

      try {
        const resMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
          reply_markup: keyboard
        });

        const message_id = resMsg.data.result.message_id;

        await axios.post(GAS_WEB_APP_URL, {
          action: 'markMessageSent',
          row,
          message_id
        });

        console.log(`✅ Заявка #${row} отправлена`);
      } catch (err) {
        console.error(`❌ Ошибка при отправке заявки #${row}:`, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('❌ Ошибка при запросе отложенных заявок:', err.response?.data || err.message);
  }
}

// 🔘 Ручной вызов через POST
app.post('/send-pending', async (req, res) => {
  const { action } = req.body;
  if (action === 'sendPending') {
    await checkPendingRequestsAndSend();
    return res.send('✅ Заявки успешно отправлены');
  }
  res.status(400).send('❌ Неверный action');
});

// 📦 Telegram-хендлеры
try {
  const setupTelegramHandlers = require('./telegram-handlers');
  setupTelegramHandlers(app, userStates);
  console.log('✅ Telegram-хендлеры подключены');
} catch (e) {
  console.error('❌ Ошибка загрузки telegram-handlers.js:', e.message);
}

// 🚀 Запуск сервера
app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  await setTelegramWebhook();
  await checkPendingRequestsAndSend(); // начальная проверка
  setInterval(checkPendingRequestsAndSend, 2 * 60 * 1000); // каждые 2 минуты
});
