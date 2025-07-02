const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { TELEGRAM_API, TELEGRAM_FILE_API, BOT_TOKEN, GOOGLE_DRIVE_FOLDER_ID } = require('../config');

async function downloadTelegramFile(fileId, fileName) {
  const filePathRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = filePathRes.data.result.file_path;
  const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

  const fileStream = await axios.get(fileUrl, { responseType: "stream" });
  const tempPath = path.join(__dirname, fileName);
  const writer = fs.createWriteStream(tempPath);

  return new Promise((resolve, reject) => {
    fileStream.data.pipe(writer);
    writer.on("finish", () => resolve(tempPath));
    writer.on("error", reject);
  });
}

async function uploadToDrive(tempPath, fileName) {
  const driveApi = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const accessToken = process.env.GDRIVE_TOKEN;

  const metadata = {
    name: fileName,
    parents: [FOLDER_ID]
  };

  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata), { contentType: "application/json" });
  form.append("file", fs.createReadStream(tempPath));

  const headers = {
    ...form.getHeaders(),
    Authorization: `Bearer ${accessToken}`
  };

  const res = await axios.post(driveApi, form, { headers });
  fs.unlinkSync(tempPath);

  return `https://drive.google.com/file/d/${res.data.id}/view?usp=sharing`;
}

module.exports = {
  downloadTelegramFile,
  uploadToDrive
};
