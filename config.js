const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";

module.exports = {
  BOT_TOKEN,
  TELEGRAM_API: `https://api.telegram.org/bot${BOT_TOKEN}`,
  TELEGRAM_FILE_API: `https://api.telegram.org/file/bot${BOT_TOKEN}`,
  GOOGLE_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyFKlzM5JgcBOss238ofdwi_TcC4TIGMPOwpFb86yvV9YDHoXnjqYIs9U2EMg-TX2ql/exec",
  FOLDER_ID: "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF",
  PORT: process.env.PORT || 3000
};
