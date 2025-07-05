const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

async function uploadTelegramPhotoToDrive(fileUrl) {
  const fileName = `photo_${Date.now()}.jpg`;
  const tempPath = path.join(__dirname, fileName);

  const writer = fs.createWriteStream(tempPath);
  const response = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const form = new FormData();
  form.append('file', fs.createReadStream(tempPath));
  const res = await axios.post('https://script.google.com/macros/s/AKfycbxeXikOhZy-HlXNTh4Dpz7FWqBf1pRi6DWpzGQlFQr8TSV46KUU_-FJF976oQrxpHAx/exec', form, {
    headers: form.getHeaders(),
  });

  fs.unlinkSync(tempPath);
  return res.data.url;
}

module.exports = { uploadTelegramPhotoToDrive };
