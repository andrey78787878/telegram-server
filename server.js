// Проверка переменной окружения PORT
if (!process.env.PORT) {
  console.warn("⚠️ Переменная PORT не установлена! Render автоматически задаёт PORT, нужно её использовать.");
} else {
  console.log("✅ Render запустил на порту:", process.env.PORT);
}

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const userStates = {};
require('./telegram-handlers')(app, userStates);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
