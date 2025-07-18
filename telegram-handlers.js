const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const https = require('https');

module.exports = (app, userStates) => {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
  const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
  const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const AUTHORIZED_USERS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', '@Andrey_Tkach_MB'];

  const sendMessage = async (chatId, text, options = {}) => {
    return axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      ...options,
    });
  };

  const editMessage = async (chatId, messageId, text, options = {}) => {
    return axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  };

  const deleteMessage = async (chatId, messageId) => {
    return axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
  };

  const getFileLink = async (fileId) => {
    const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    return `${TELEGRAM_FILE_API}/${fileInfo.data.result.file_path}`;
  };

  const uploadToGoogleDrive = async (url, filename) => {
    const filePath = path.join('/tmp', filename);
    const writer = fs.createWriteStream(filePath);
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
    });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('filename', filename);
    form.append('folderId', GOOGLE_DRIVE_FOLDER_ID);

    const uploadResponse = await axios.post(`${GAS_WEB_APP_URL}?action=uploadPhoto`, form, {
      headers: form.getHeaders(),
    });
    fs.unlinkSync(filePath);
    return uploadResponse.data.fileUrl;
  };

  const delayDelete = (chatId, messageId, delay = 60000) => {
    setTimeout(() => deleteMessage(chatId, messageId), delay);
  };

  app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (!body) return res.sendStatus(200);

    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const username = msg.from.username ? `@${msg.from.username}` : '';
      const userState = userStates[chatId];

      if (userState && userState.expecting === 'photo' && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileUrl = await getFileLink(fileId);
        const fileLink = await uploadToGoogleDrive(fileUrl, `${chatId}_${Date.now()}.jpg`);
        userState.photo = fileLink;
        userState.expecting = 'sum';
        const sent = await sendMessage(chatId, '💰 Введите сумму работ:');
        userState.tempMessages.push(sent.data.message_id);
        return res.sendStatus(200);
      }

      if (userState && userState.expecting === 'sum' && msg.text) {
        userState.sum = msg.text;
        userState.expecting = 'comment';
        const sent = await sendMessage(chatId, '📝 Введите комментарий:');
        userState.tempMessages.push(sent.data.message_id);
        return res.sendStatus(200);
      }

      if (userState && userState.expecting === 'comment' && msg.text) {
        userState.comment = msg.text;
        userState.expecting = null;

        await axios.post(GAS_WEB_APP_URL, {
          photo: userState.photo,
          sum: userState.sum,
          comment: userState.comment,
          message_id: userState.messageId,
          row: userState.row,
          username: userState.username,
          executor: username,
        });

        const response = await axios.post(`${GAS_WEB_APP_URL}?action=getRowInfo`, {
          message_id: userState.messageId,
        });
        const rowInfo = response.data;
        const finalText = `📌 Заявка #${rowInfo.row} закрыта.\n📎 Фото: ${userState.photo}\n💰 Сумма: ${userState.sum} сум\n👤 Исполнитель: ${username}\n✅ Статус: Выполнено\n📌 Комментарий: ${userState.comment}\n🔴 Просрочка: ${rowInfo.overdue} дн.`;

        await editMessage(chatId, userState.messageId, finalText);

        for (const msgId of userState.tempMessages) delayDelete(chatId, msgId);
        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }

    if (body.callback_query) {
      const cb = body.callback_query;
      const chatId = cb.message.chat.id;
      const msgId = cb.message.message_id;
      const username = cb.from.username ? `@${cb.from.username}` : '';

      if (!AUTHORIZED_USERS.includes(`@${cb.from.username}`)) {
        await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: cb.id,
          text: '❌ У вас нет доступа к этой функции.',
          show_alert: true,
        });
        return res.sendStatus(200);
      }

      const data = cb.data;

      if (data.startsWith('accept_')) {
        const row = data.split('_')[1];
        await axios.post(GAS_WEB_APP_URL, {
          status: 'В работе 🟢',
          message_id: msgId,
          row,
          executor: username,
        });
        await editMessage(chatId, msgId, `${cb.message.text}\n\n🟢 В работе исполнителем: ${username}`, {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Выполнено ✅', callback_data: `done_${row}` },
              { text: 'Ожидает поставки 📦', callback_data: `wait_${row}` },
              { text: 'Отмена ❌', callback_data: `cancel_${row}` },
            ]],
          },
        });
        return res.sendStatus(200);
      }

      if (data.startsWith('done_')) {
        const row = data.split('_')[1];
        userStates[chatId] = {
          expecting: 'photo',
          tempMessages: [],
          messageId: msgId,
          row,
          username,
        };
        const sent = await sendMessage(chatId, '📸 Пришлите фото выполненных работ:');
        userStates[chatId].tempMessages.push(sent.data.message_id);
        return res.sendStatus(200);
      }

      if (data.startsWith('wait_') || data.startsWith('cancel_')) {
        const row = data.split('_')[1];
        const status = data.startsWith('wait_') ? 'Ожидает поставки 📦' : 'Отменено ❌';
        await axios.post(GAS_WEB_APP_URL, {
          status,
          message_id: msgId,
          row,
          executor: username,
        });
        await editMessage(chatId, msgId, `${cb.message.text}\n\n${status} от: ${username}`);
        return res.sendStatus(200);
      }
    }

    return res.sendStatus(200);
  });
};
