const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const open = require('open');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

function loadSavedCredentialsIfExist() {
  try {
    const content = fs.readFileSync(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const key = client.credentials;
  const payload = {
    type: 'authorized_user',
    client_id: credentials.installed.client_id,
    client_secret: credentials.installed.client_secret,
    refresh_token: key.refresh_token,
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload));
}

async function authorize() {
  const client = loadSavedCredentialsIfExist();
  if (client) {
    console.log('✅ Уже авторизован с сохранённым токеном.');
    return client;
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id, client_secret, redirect_uris[0]
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('🔗 Открой эту ссылку в браузере, чтобы авторизовать доступ:');
  console.log(authUrl);

  await open(authUrl);

  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  readline.question('📥 Вставь сюда код авторизации: ', async (code) => {
    readline.close();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    await saveCredentials(oAuth2Client);
    console.log('✅ Авторизация прошла успешно, токен сохранён.');
  });
}

authorize();
