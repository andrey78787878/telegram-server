require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;

module.exports = {
  BOT_TOKEN,
  TELEGRAM_API: `https://api.telegram.org/bot${BOT_TOKEN}`,
  TELEGRAM_FILE_API: `https://api.telegram.org/file/bot${BOT_TOKEN}`,
  GAS_URL: process.env.GAS_URL,
  PORT: process.env.PORT || 3000
};
