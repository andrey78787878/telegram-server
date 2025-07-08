require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

const EXECUTORS = ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'];
const userStates = {};
const stepDataMap = {};

app.post('/webhook', async (req, res) => {
  console.log('📩 Webhook получен');
  const body = req.body;

  try {
    if (body.callback_query) {
      const cb = body.callback_query;
      const chatId = cb.message.chat.id;
      const messageId = cb.message.message_id;
      const data = cb.data;

      if (data.startsWith('startWork:')) {
        const [_, row, pizzeria, problem] = data.split(':');
        stepDataMap[chatId] = { row, pizzeria, problem, messageId };
        await askExecutor(chatId, messageId);
      } else if (data.startsWith('executor:')) {
        const username = data.split(':')[1];
        if (username === 'manual') {
          userStates[chatId] = { waitingForManualExecutor: true };
          await sendMessage(chatId, 'Введите имя исполнителя вручную:');
        } else {
          stepDataMap[chatId].username = username.replace('@', '');
          await updateToWork(chatId);
        }
      } else if (data === 'done') {
        await sendMessage(chatId, 'Загрузите фото выполненных работ:');
        userStates[chatId] = { waitPhoto: true };
      } else if (data === 'cancel') {
        await sendMessage(chatId, 'Заявка отменена.');
      }
    }

    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;

      if (userStates[chatId]?.waitingForManualExecutor) {
        stepDataMap[chatId].username = msg.text.replace('@', '');
        delete userStates[chatId];
        await updateToWork(chatId);
      } else if (userStates[chatId]?.waitPhoto && msg.photo) {
        const fileId = msg.photo.at(-1).file_id;
        const file = await getFile(fileId);
        const filePath = file.result.file_path;
        const url = `${TELEGRAM_FILE_API}/${filePath}`;
        const photoBuffer = await axios.get(url, { responseType: 'arraybuffer' });
        const fileName = `${Date.now()}.jpg`;

        const localDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir);
        const filePathLocal = path.join(localDir, fileName);
        fs.writeFileSync(filePathLocal, photoBuffer.data);

        stepDataMap[chatId].photo = {
          buffer: photoBuffer.data,
          fileName,
        };

        delete userStates[chatId];
        userStates[chatId] = { waitSum: true };
        await sendMessage(chatId, 'Введите сумму выполненных работ (в сумах):');
      } else if (userStates[chatId]?.waitSum) {
        stepDataMap[chatId].sum = msg.text;
        delete userStates[chatId];
        userStates[chatId] = { waitComment: true };
        await sendMessage(chatId, 'Добавьте комментарий по заявке:');
      } else if (userStates[chatId]?.waitComment) {
        stepDataMap[chatId].comment = msg.text;
        delete userStates[chatId];

        const form = new FormData();
        form.append('photo', Buffer.from(stepDataMap[chatId].photo.buffer), {
          filename: stepDataMap[chatId].photo.fileName,
        });
        form.append('row', stepDataMap[chatId].row);
        form.append('sum', stepDataMap[chatId].sum);
        form.append('comment', stepDataMap[chatId].comment);
        form.append('username', stepDataMap[chatId].username);
        form.append('pizzeria', stepDataMap[chatId].pizzeria);
        form.append('problem', stepDataMap[chatId].problem);

        const gasRes = await axios.post(GAS_WEB_APP_URL, form, {
          headers: form.getHeaders(),
        });

        const { photoLink, delay } = gasRes.data;

        const finalText = `
🏬 Пиццерия: #${stepDataMap[chatId].pizzeria}
🛠 Проблема: ${stepDataMap[chatId].problem}
💬 Комментарий: ${stepDataMap[chatId].comment}

📌 Заявка #${stepDataMap[chatId].row} закрыта.
📎 Фото: [ссылка](${photoLink})
💰 Сумма: ${stepDataMap[chatId].sum} сум
👤 Исполнитель: @${stepDataMap[chatId].username}
✅ Статус: Выполнено
⏰ Просрочка: ${delay} дн.
        `;
        await sendMessage(chatId, finalText, { parse_mode: 'Markdown' });
      }
    }

    res.sendStatus(200); // Только здесь!
  } catch (err) {
    console.error('Ошибка:', err);
    res.sendStatus(500);
  }
});

// ==== Хелперы ====
async function askExecutor(chatId) {
  const keyboard = {
    inline_keyboard: EXECUTORS.map(name => {
      if (name === 'Текстовой подрядчик') {
        return [{ text: '📝 Ввести вручную', callback_data: 'executor:manual' }];
      }
      return [{ text: name, callback_data: `executor:${name}` }];
    }),
  };
  await sendMessage(chatId, 'Выберите исполнителя:', { reply_markup: keyboard });
}

async function updateToWork(chatId) {
  await sendMessage(chatId, `✅ Исполнитель @${stepDataMap[chatId].username} принял заявку в работу.`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Выполнено', callback_data: 'done' }],
        [{ text: '❌ Отмена', callback_data: 'cancel' }],
      ],
    },
  });
}

async function sendMessage(chatId, text, extra = {}) {
  return axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function getFile(fileId) {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  return res.data;
}

app.listen(process.env.PORT || 3000, () => {
  console.log('🤖 Server running on port 3000');
});
