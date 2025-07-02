const { google } = require("googleapis");
const { GOOGLE_SCRIPT_URL } = require("./config");

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

async function updateStatus(messageId, status, executor) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: credentials.SPREADSHEET_ID,
    range: "Заявки!Q2:Q",
  });

  const rows = res.data.values;
  const rowIndex = rows.findIndex((row) => row[0] == messageId);
  if (rowIndex === -1) return;

  const rowNumber = rowIndex + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId: credentials.SPREADSHEET_ID,
    range: `Заявки!K${rowNumber}:P${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[status, "", "", "", "", executor]],
    },
  });
}

async function updateCompletionData(rowNumber, date, sum, delay, photoUrl, comment) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: credentials.SPREADSHEET_ID,
    range: `Заявки!L${rowNumber}:R${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[date, sum, delay, photoUrl, comment]],
    },
  });
}

module.exports = { updateStatus, updateCompletionData };
