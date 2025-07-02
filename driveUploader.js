const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const credentials = require("../config");

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/drive"],
});

const drive = google.drive({ version: "v3", auth });

async function uploadToDrive(filePath, fileName) {
  const fileMetadata = {
    name: fileName,
    parents: [credentials.FOLDER_ID],
  };
  const media = {
    mimeType: "image/jpeg",
    body: fs.createReadStream(filePath),
  };
  const res = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: "id",
  });
  const fileId = res.data.id;
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });
  return `https://drive.google.com/uc?id=${fileId}`;
}

module.exports = { uploadToDrive };
