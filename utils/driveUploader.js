const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { google } = require("googleapis");

// Замените на ваш путь к JSON-файлу сервисного аккаунта
const SERVICE_ACCOUNT_FILE = path.join(__dirname, "credentials.json");

// ID папки на Google Диске, куда будут сохраняться фото
const FOLDER_ID = "1lYjywHLtUgVRhV9dxW0yIhCJtEfl30ClaYSECjrD8ENyh1YDLEYEvbnegKe4_-HK2QlLWzVF";

// Авторизация через сервисный аккаунт
const auth = new google.auth.GoogleAuth({
  keyFile: SERVICE_ACCOUNT_FILE,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });

/**
 * Загружает фото с Telegram на Google Диск
 * @param {string} fileId - Telegram file_id
 * @param {string} telegramToken - токен бота
 * @returns {Promise<string>} - ссылка на публичный файл
 */
async function uploadTelegramPhotoToDrive(fileId, telegramToken) {
  try {
    // Получаем путь к файлу на серверах Telegram
    const fileInfo = await axios.get(
      `https://api.telegram.org/bot${telegramToken}/getFile?file_id=${fileId}`
    );
    const filePath = fileInfo.data.result.file_path;

    // Скачиваем файл
    const url = `https://api.telegram.org/file/bot${telegramToken}/${filePath}`;
    const response = await axios.get(url, { responseType: "stream" });

    const fileName = path.basename(filePath);

    // Загружаем на Google Диск
    const uploadResponse = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [FOLDER_ID],
      },
      media: {
        mimeType: response.headers["content-type"],
        body: response.data,
      },
    });

    const fileIdOnDrive = uploadResponse.data.id;

    // Делаем файл публичным
    await drive.permissions.create({
      fileId: fileIdOnDrive,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
    });

    // Получаем прямую ссылку
    const webLink = `https://drive.google.com/uc?id=${fileIdOnDrive}&export=view`;
    return webLink;
  } catch (error) {
    console.error("Ошибка при загрузке фото на Google Диск:", error.message);
    throw error;
  }
}

module.exports = { uploadTelegramPhotoToDrive };
