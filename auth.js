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

// ✅ Используем GOOGLE_CREDENTIALS из переменной окружения
const creds = process.env.GOOGLE_CREDENTIALS;
if (!creds) throw new Error('Credentials не загружены.');
const credentials = JSON.parse(creds);

function createOAuthClient() {
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

router.get('/auth/google', (req, res) => {
  const oAuth2Client = createOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.redirect(authUrl);
});

router.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  const oAuth2Client = createOAuthClient();

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.send('✅ Аутентификация прошла успешно. Токены сохранены.');
  } catch (error) {
    console.error('Ошибка при получении токена:', error);
    res.status(500).send('❌ Ошибка при авторизации.');
  }
});

module.exports = router;
