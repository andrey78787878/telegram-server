const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cron = require("node-cron");

const BOT_TOKEN = "8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby_gOrwjaB7LgGJcCarpUM8SsyhWzUtMJSN3kddZKm5AToFlWQsErAKxNu9l2UC2JRE/exec";
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  console.log("Received webhook:", req.body);
  res.sendStatus(200);
});

cron.schedule("0 9 * * *", () => {
  console.log("Выполняется ежедневная задача в 9 утра.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});