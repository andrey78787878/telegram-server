// auth.js (для Render)
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets'
];

const TOKEN_PATH = path.join(__dirname, '../token.json');

// Загружаем credentials из переменной окружения
function loadCredentials() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('❌ Переменная среды GOOGLE_CREDENTIALS не установлена.');
  }

  try {
    const raw = Buffer.from(process.env.GOOGLE_CREDENTIALS, 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('❌ Ошибка при разборе GOOGLE_CREDENTIALS: ' + err.message);
  }
}

// Создаём клиента OAuth2
function createOAuthClient() {
  const credentials = loadCredentials();
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// Старт авторизации
router.get('/auth/google', (req, res) => {
  try {
    const oAuth2Client = createOAuthClient();
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
    });
    res.redirect(authUrl);
  } catch (error) {
    console.error('Ошибка инициализации клиента:', error);
    res.status(500).send('Ошибка инициализации авторизации.');
  }
});

// Обработка кода авторизации
router.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  const oAuth2Client = createOAuthClient();

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.send('✅ Авторизация прошла успешно. Токены сохранены.');
  } catch (error) {
    console.error('Ошибка при получении токена:', error);
    res.status(500).send('❌ Ошибка при авторизации.');
  }
});

module.exports = router;
