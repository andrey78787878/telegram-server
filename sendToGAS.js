// sendToGAS.js
const axios = require('axios');

module.exports = async function sendToGAS(data, GAS_WEB_APP_URL) {
  try {
    const response = await axios.post(GAS_WEB_APP_URL, data);
    console.log('📤 Данные отправлены в GAS:', response.status);
  } catch (error) {
    console.error('❌ Ошибка при отправке в GAS:', error.message);
  }
};
