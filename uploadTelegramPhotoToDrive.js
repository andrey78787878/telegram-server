const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q';
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_UPLOAD_URL = 'https://script.google.com/macros/s/AKfycbwnxJm00oGfpCChFrhu0ov3PZ7iVn7i1RTRnyeP8DhXCw2QUHqWRyiyGDU5jvJROY9G/exec';

async function uploadPhotoToDrive(file_id) {
  try {
    // Получаем путь к файлу на сервере Telegram
    const { data: fileInfo } = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${file_id}`);
    if (!fileInfo.ok) throw new Error('Не удалось получить путь к файлу Telegram');

    const filePath = fileInfo.result.file_path;
    const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

    // Скачиваем фото как поток
    const response = await axios.get(fileUrl, { responseType: 'stream' });

    // Формируем form-data с потоком файла
    const formData = new FormData();
    formData.append('photo', response.data, 'photo.jpg');

    // Отправляем на GAS (Google Apps Script)
    const uploadRes = await axios.post(GAS_UPLOAD_URL, formData, {
      headers: formData.getHeaders(),
    });

    if (!uploadRes.data.photoUrl) throw new Error('Не получена ссылка на фото с GAS');

    return uploadRes.data.photoUrl;
  } catch (error) {
    console.error('Ошибка загрузки фото на Google Диск:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { uploadPhotoToDrive };
