require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// === УСТАНОВКА ВЕБХУКА ПРИ ЗАПУСКЕ ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = `https://telegram-server-3cyz.onrender.com/webhook`;

async function setWebhook() {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      url: WEBHOOK_URL,
    });
    console.log("Webhook response:", res.data);
  } catch (err) {
    console.error("Ошибка при установке вебхука:", err.message);
  }
}
setWebhook();
// ====================================

const userStates = {};
require('./telegram-handlers')(app, userStates);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
