const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const TELEGRAM_FILE_API = 'https://api.telegram.org/file/bot8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';

async function uploadPhotoToDrive(file_id, TELEGRAM_FILE_API) {
  const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
  const getFileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${file_id}`;
  const res = await axios.get(getFileUrl);
  const filePath = res.data.result.file_path;
  const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

  const tempPath = path.join(__dirname, 'temp.jpg');
  const writer = fs.createWriteStream(tempPath);
  const response = await axios.get(fileUrl, { responseType: 'stream' });
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const formData = new FormData();
  formData.append('photo', fs.createReadStream(tempPath));

  const uploadRes = await axios.post('https://script.google.com/macros/s/AKfycbxeXikOhZy-HlXNTh4Dpz7FWqBf1pRi6DWpzGQlFQr8TSV46KUU_-FJF976oQrxpHAx/exec', formData, {
    headers: formData.getHeaders(),
  });

  fs.unlinkSync(tempPath);
  return uploadRes.data.photoUrl;
}

module.exports = { uploadPhotoToDrive };
