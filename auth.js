const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const router = express.Router();

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// Читаем credentials.json
function loadCredentials() {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  return JSON.parse(content).web;
}

// Сохраняем токен
function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
}

// Загружаем токен если есть
function loadToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH);
    return JSON.parse(token);
  }
  return null;
}

// OAuth2 клиент
function createOAuthClient() {
  const { client_id, client_secret, redirect_uris } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// Старт авторизации
router.get('/auth/google', (req, res) => {
  const oAuth2Client = createOAuthClient();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  res.redirect(url);
});

// Callback после авторизации
router.get('/auth/google/callback', async (req, res) => {
  const oAuth2Client = createOAuthClient();
  const code = req.query.code;

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);
    res.send('✅ Авторизация прошла успешно! Токен сохранён.');
  } catch (error) {
    console.error('❌ Ошибка авторизации:', error);
    res.status(500).send('Ошибка при авторизации.');
  }
});

// Возвращает авторизованного клиента
async function getAuthorizedClient() {
  const token = loadToken();
  if (!token) throw new Error('❌ Токен не найден. Перейди по /auth/google для авторизации.');
  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

module.exports = { router, getAuthorizedClient };
