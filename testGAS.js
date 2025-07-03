const axios = require('axios');

async function testGoogleAppsScript() {
  try {
    const response = await axios.post('https://script.google.com/macros/s/AKfycbwlJy3XL7EF7rcou2fe7O4uC2cVlmeYfM87D-M6ji4KyU0Ds0sp_SiOuT643vIhCwps/exec', {
      photo: 'https://test-link.com/photo.jpg',
      sum: '100000',
      comment: 'Тестовый комментарий',
      message_id: 99999,
      row: 44,
      username: '@TestUser',
      executor: 'Test Executor'
    });

    console.log('Ответ от GAS:', response.data);
  } catch (error) {
    console.error('Ошибка при отправке в Google Apps Script:', error.response?.data || error.message);
  }
}

testGoogleAppsScript();
