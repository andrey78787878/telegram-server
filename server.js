require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

const userStates = {};

// 🔁 Проверка отложенных заявок
async function checkPendingRequestsAndSend() {
  try {
    const res = await axios.post(GAS_WEB_APP_URL, { action: 'getPendingMessages' });
    const pending = res.data;

    if (!pending || !Array.isArray(pending)) {
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

// ✅ ДОБАВЬ ЭТО: ручной запуск отправки
app.post('/webhook', async (req, res) => {
  const { action } = req.body;
  if (action === 'sendPending') {
    await checkPendingRequestsAndSend();
    return res.send('✅ Заявки успешно отправлены');
  }
  res.status(400).send('❌ Неверный action');
});

// 🚀 Автостарт при запуске сервера
checkPendingRequestsAndSend(); // при старте
// 📦 Каждые 2 минуты
setInterval(checkPendingRequestsAndSend, 2 * 60 * 1000);

// 🔊 Запуск Express сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

// 📦 Подключение логики Telegram
const setupTelegramHandlers = require('./telegram-handlers');
setupTelegramHandlers(app, userStates);
