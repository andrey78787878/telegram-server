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
