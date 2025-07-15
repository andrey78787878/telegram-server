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
const requiredEnvVars = ['BOT_TOKEN', 'GAS_WEB_APP_URL', 'TELEGRAM_CHAT_ID', 'WEBHOOK_URL'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ Не хватает переменных среды:', missingVars.join(', '));
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const userStates = {};

// ✅ Установка вебхука
async function setTelegramWebhook() {
  try {
    const res = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: WEBHOOK_URL,
      drop_pending_updates: true
    });
    console.log('✅ Вебхук установлен:', res.data);
  } catch (err) {
    console.error('❌ Ошибка установки вебхука:', err.response?.data || err.message);
    process.exit(1);
  }
}

// 🔁 Проверка отложенных заявок
async function checkPendingRequestsAndSend() {
  try {
    console.log('🔍 Проверка отложенных заявок...');
    const res = await axios.post(GAS_WEB_APP_URL, { 
      action: 'getPendingMessages' 
    }, {
      timeout: 10000 // 10 секунд таймаут
    });
    
    const pending = res.data;

    if (!pending || !Array.isArray(pending) || pending.length === 0) {
      console.log('ℹ️ Нет заявок для отправки.');
      return;
    }

    console.log(`📨 Найдено ${pending.length} отложенных заявок`);

    for (const [index, rowObj] of pending.entries()) {
      try {
        const {
          row, pizzaria, classif, category, problem,
          initiator, phone, deadline
        } = rowObj;

        const message = `📍 <b>Заявка #${row}</b>\n\n` +
          `🍕 <b>Пиццерия:</b> ${pizzaria || '—'}\n` +
          `🔧 <b>Классификация:</b> ${classif || '—'}\n` +
          `📂 <b>Категория:</b> ${category || '—'}\n` +
          `📋 <b>Проблема:</b> ${problem || '—'}\n` +
          `👤 <b>Инициатор:</b> ${initiator || '—'}\n` +
          `📞 <b>Тел:</b> ${phone || '—'}\n` +
          `🕓 <b>Срок:</b> ${deadline || '—'}`;

        const keyboard = {
          inline_keyboard: [
            [{ text: 'Принять в работу 🟢', callback_data: `in_progress:${row}` }]
          ]
        };

        const resMsg = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
          reply_markup: keyboard
        });

        await axios.post(GAS_WEB_APP_URL, {
          action: 'markMessageSent',
          row,
          message_id: resMsg.data.result.message_id
        });

        console.log(`✅ [${index + 1}/${pending.length}] Заявка #${row} отправлена`);
        
        // Небольшая задержка между отправками
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (err) {
        console.error(`❌ Ошибка при отправке заявки:`, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error('❌ Ошибка при запросе отложенных заявок:', err.message);
  }
}

// 🔘 Ручной вызов через POST
app.post('/send-pending', async (req, res) => {
  try {
    const { action, secret } = req.body;
    
    if (secret !== process.env.API_SECRET) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
    
    if (action === 'sendPending') {
      await checkPendingRequestsAndSend();
      return res.json({ status: 'success', message: 'Заявки успешно отправлены' });
    }
    
    res.status(400).json({ error: 'Неверный action' });
  } catch (err) {
    console.error('Ошибка в /send-pending:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 🏓 Проверка работоспособности
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    services: {
      telegram: !!BOT_TOKEN,
      google_sheets: !!GAS_WEB_APP_URL
    }
  });
});

// 📦 Telegram-хендлеры
try {
  const setupTelegramHandlers = require('./telegram-handlers');
  setupTelegramHandlers(app, userStates);
  console.log('✅ Telegram-хендлеры подключены');
} catch (e) {
  console.error('❌ Ошибка загрузки telegram-handlers.js:', e);
  process.exit(1);
}

// 🚀 Запуск сервера
app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  
  
