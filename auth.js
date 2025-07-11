// routes/auth.js
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const CREDENTIALS_PATH = '/etc/secrets/credentials.json'; // путь для Render

function loadCredentials() {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  return JSON.parse(content).installed;
}

router.get('/auth/google', (req, res) => {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0] // например, http://localhost:3000/auth/google/callback
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  res.redirect(authUrl);
});

router.get('/auth/google/callback', async (req, res) => {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const code = req.query.code;
  if (!code) return res.status(400).send('No code found in request');

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // ❗ здесь можно сохранить токены в файл или переменные окружения
    res.send('Успешно авторизовано!');
  } catch (err) {
    console.error('Ошибка авторизации:', err);
    res.status(500).send('Ошибка при авторизации');
  }
});

module.exports = router;
