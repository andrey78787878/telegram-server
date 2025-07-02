const axios = require("axios");
const { GOOGLE_SCRIPT_URL } = require("./config");

async function updateGoogleSheet(data) {
  try {
    const res = await axios.post(GOOGLE_SCRIPT_URL, data);
    return res.data;
  } catch (error) {
    console.error("Ошибка при отправке в Google Sheets:", error.message);
    throw error;
  }
}

module.exports = { updateGoogleSheet };
