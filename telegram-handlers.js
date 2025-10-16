// index.js
'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const https = require('https');
axios.defaults.httpsAgent = new https.Agent({ family: 4, keepAlive: true });

const { google } = require('googleapis');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL || null;

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY; // JSON string

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!SHEET_ID) throw new Error('SHEET_ID is required');
if (!GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is required');

const MANAGERS = ['@Andrey_Tkach_Dodo', '@Davr_85', '@EvelinaB87'];
const EXECUTORS = ['@Andrey_Tkach_Dodo', '@Olim19', '@Davr_85', '@Oblayor_04_09', '@IkromovichV', '@EvelinaB87'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

const userStorage = new Map();
const errorMessageCooldown = new Map();

// state storage
const userStates = {}; // key: `${chatId}:${sheetRow}` -> { stage, row, username, userId, chatId, ... }

// Google Sheets auth
const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
const jwtClient = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth: jwtClient });

// Helpers
function extractRowFromCallbackData(callbackData) {
  if (!callbackData) return null;
  const parts = callbackData.split(':');
  return parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : null;
}

function extractRowFromMessage(text) {
  if (!text) return null;
  const match = text.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function parseRequestMessage(text) {
  if (!text) return null;
  const result = {};
  const lines = text.split('\n');
  lines.forEach(line => {
    if (line.includes('Пиццерия:')) result.pizzeria = line.split(':')[1].trim();
    if (line.includes('Категория:')) result.category = line.split(':')[1].trim();
    if (line.includes('Проблема:')) result.problem = line.split(':')[1].trim();
    if (line.includes('Инициатор:')) result.initiator = line.split(':')[1].trim();
    if (line.includes('Телефон:')) result.phone = line.split(':')[1].trim();
    if (line.includes('Срок:')) result.deadline = line.split(':')[1].trim();
  });
  return result;
}

function formatCompletionMessage(data, diskUrl = null) {
  const photoLink = diskUrl ? diskUrl : (data.photoUrl ? data.photoUrl : null);
  return `
✅ Заявка #${data.row} ${data.isEmergency ? '🚨 (АВАРИЙНАЯ)' : ''} закрыта
${photoLink ? `\n📸 ${photoLink}\n` : ''}
💬 Комментарий: ${data.comment || 'нет комментария'}
💰 Сумма: ${data.sum || '0'} сум
👤 Исполнитель: ${data.executor}
${data.delayDays > 0 ? `🔴 Просрочка: ${data.delayDays} дн.` : ''}
━━━━━━━━━━━━
🏢 Пиццерия: ${data.originalRequest?.pizzeria || 'не указано'}
🔧 Проблема: ${data.originalRequest?.problem || 'не указано'}
  `.trim();
}

async function sendMessage(chatId, text, options = {}) {
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    try {
      const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      });
      return response;
    } catch (error) {
      if (error.response?.data?.error_code === 429) {
        const retryAfter = error.response.data.parameters.retry_after || 10;
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        attempts++;
        continue;
      }
      console.error('Send message error:', error.response?.data || error.message);
      throw error;
    }
  }
  throw new Error(`Failed to send message after ${maxAttempts} attempts`);
}

async function editMessageSafe(chatId, messageId, text, options = {}) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options
    });
    return response;
  } catch (error) {
    if (error.response?.data?.description?.includes('no text in the message') || 
        error.response?.data?.description?.includes('message to edit not found')) {
      return await sendMessage(chatId, text, options);
    }
    console.error('Edit message error:', error.response?.data || error.message);
    throw error;
  }
}

async function sendButtonsWithRetry(chatId, messageId, buttons, fallbackText) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons }
    });
    return response;
  } catch (error) {
    if (error.response?.data?.description?.includes('not modified')) {
      return { ok: true };
    }
    return await sendMessage(chatId, fallbackText, {
      reply_markup: { inline_keyboard: buttons }
    });
  }
}

async function deleteMessageSafe(chatId, messageId) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId
    });
    return response;
  } catch (error) {
    console.error('Delete message error:', error.response?.data || error.message);
    return null;
  }
}

async function getTelegramFileUrl(fileId) {
  try {
    const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
    const url = `${TELEGRAM_FILE_API}/${data.result.file_path}`;
    return url;
  } catch (error) {
    console.error('Get file URL error:', error.response?.data || error.message);
    return null;
  }
}

async function sendToGAS(data) {
  if (!GAS_WEB_APP_URL) return null;
  try {
    const response = await axios.post(GAS_WEB_APP_URL, data);
    return response.data;
  } catch (error) {
    console.error('Error sending to GAS:', error.message);
    return null;
  }
}

/**
 * Google Sheets helpers
 * We read entire sheet A1:Z and map headers to column indices,
 * then search for message_id column value.
 */

async function readSheetAll() {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:Z`
  });
  return resp.data.values || [];
}

async function findRowByMessageId(messageId) {
  const rows = await readSheetAll();
  if (!rows.length) return null;
  const headers = rows[0].map(h => (h || '').toString().trim());
  const msgColIndex = headers.findIndex(h => h.toLowerCase() === 'message_id' || h.toLowerCase() === 'message id');
  if (msgColIndex === -1) return null;
  for (let i = 1; i < rows.length; i++) {
    const v = rows[i][msgColIndex];
    if (v == null) continue;
    if (String(v) === String(messageId)) {
      return i + 1; // sheet row number (1-indexed)
    }
  }
  return null;
}

async function getHeaderMap() {
  const rows = await readSheetAll();
  const headers = rows[0].map(h => (h || '').toString().trim());
  // map header -> column index (1-based)
  const map = {};
  headers.forEach((h, idx) => {
    map[h] = idx + 1;
  });
  return map;
}

async function updateSheetRow(sheetRowNumber, updates) {
  // updates: { headerName: value, ... }
  const headerMap = await getHeaderMap();
  if (!headerMap || Object.keys(headerMap).length === 0) {
    throw new Error('Could not read headers from sheet');
  }

  // Build values array for the row range A{row}:Z{row}
  const totalCols = Object.keys(headerMap).length;
  const rowValues = new Array(totalCols).fill('');
  for (const [header, val] of Object.entries(updates)) {
    const col = headerMap[header];
    if (col) rowValues[col - 1] = val;
  }

  const range = `${SHEET_NAME}!A${sheetRowNumber}:${String.fromCharCode(64 + totalCols)}${sheetRowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values: [rowValues]
    }
  });
}

/**
 * Utility to only update specific columns (safer).
 * We compute A{row}:... for the columns in updates.
 */
async function updateSheetRowPartial(sheetRowNumber, updates) {
  const headerMap = await getHeaderMap();
  const headerEntries = Object.entries(updates).filter(([h]) => headerMap[h]);
  if (!headerEntries.length) return;
  // We'll write contiguous ranges per chunk; but simplest: write each column separately.
  const requests = [];
  for (const [header, val] of headerEntries) {
    const colIndex = headerMap[header];
    const colLetter = columnLetter(colIndex);
    const range = `${SHEET_NAME}!${colLetter}${sheetRowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[val]] }
    });
  }
}

function columnLetter(col) {
  // 1 -> A, 27 -> AA, etc.
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// calculate delay days from "Предельный срок исполнения" (deadline string in row)
function calculateDelayDays(deadline) {
  if (!deadline) return 0;
  try {
    const deadlineDate = new Date(deadline);
    const today = new Date();
    const diffTime = today - deadlineDate;
    return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  } catch (e) {
    console.error('Error calculating delay:', e);
    return 0;
  }
}

// Express app
const app = express();
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Save user id mapping when we have username
    if (body.message?.from) {
      const user = body.message.from;
      if (user.username) {
        userStorage.set(`@${user.username}`, user.id);
      }
    }

    // handle callback_query
    if (body.callback_query) {
      const { callback_query } = body;
      const user = callback_query.from;
      if (user.username) userStorage.set(`@${user.username}`, user.id);

      const msg = callback_query.message;
      const chatId = msg.chat.id;
      const messageId = msg.message_id; // message that contains the request/buttons
      const username = user.username ? `@${user.username}` : null;
      const data = callback_query.data;

      // answer callback to stop spinner
      await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callback_query.id }).catch(()=>{});

      // Find sheet row: try callback data row, else by message_id in sheet
      let sheetRow = extractRowFromCallbackData(data);
      if (!sheetRow || isNaN(sheetRow)) {
        sheetRow = await findRowByMessageId(messageId);
      }

      if (!sheetRow) {
        await sendMessage(chatId, '❌ Ошибка: не найдена связанная заявка в таблице.');
        return res.sendStatus(200);
      }

      // check authorization
      if (!AUTHORIZED_USERS.includes(username)) {
        const accessDeniedMsg = await sendMessage(chatId, '❌ У вас нет доступа.');
        setTimeout(() => deleteMessageSafe(chatId, accessDeniedMsg.data.result.message_id), 30000);
        return res.sendStatus(200);
      }

      // Accept in work
      if (data.startsWith('accept') || data === 'accept') {
        if (!MANAGERS.includes(username)) {
          const notManagerMsg = await sendMessage(chatId, '❌ Только менеджеры могут назначать заявки.');
          setTimeout(() => deleteMessageSafe(chatId, notManagerMsg.data.result.message_id), 30000);
          return res.sendStatus(200);
        }

        const requestData = parseRequestMessage(msg.text || msg.caption);
        // build executor buttons
        const buttons = EXECUTORS.map(e => ([{ text: e, callback_data: `executor:${e}:${sheetRow}` }]));
        const chooseExecutorMsg = await sendMessage(chatId, `👷 Выберите исполнителя для заявки #${sheetRow}:`, {
          reply_markup: { inline_keyboard: buttons }
        });
        setTimeout(async () => {
          try { await deleteMessageSafe(chatId, chooseExecutorMsg.data.result.message_id); } catch(e){}
        }, 60000);

        await sendToGAS({
          row: sheetRow,
          status: 'Принята в работу',
          message_id: messageId,
          pizzeria: requestData?.pizzeria,
          problem: requestData?.problem,
          deadline: requestData?.deadline,
          initiator: requestData?.initiator,
          phone: requestData?.phone,
          category: requestData?.category,
          manager: username,
          timestamp: new Date().toISOString()
        });

        return res.sendStatus(200);
      }

      // Executor selected
      if (data.startsWith('executor:')) {
        const executorUsername = data.split(':')[1];
        const requestData = parseRequestMessage(msg.text || msg.caption);

        const actionButtons = [
          [
            { text: '✅ Выполнено', callback_data: `done:${sheetRow}` },
            { text: '⏳ Ожидает', callback_data: `wait:${sheetRow}` },
            { text: '❌ Отмена', callback_data: `cancel:${sheetRow}` }
          ]
        ];

        await sendButtonsWithRetry(chatId, messageId, actionButtons, `Выберите действие для заявки #${sheetRow}:`);
        await sendMessage(chatId, `📢 ${executorUsername}, вам назначена заявка #${sheetRow}!`);
        const executorId = userStorage.get(executorUsername);
        if (executorId) {
          await sendMessage(executorId, `📌 Вам назначена заявка #${sheetRow}\n\n🍕 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n🔧 Проблема: ${requestData?.problem || 'не указано'}\n🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n⚠️ Приступайте к выполнению`);
        } else {
          console.warn('Не найден executorId для', executorUsername);
        }

        await sendToGAS({
          row: sheetRow,
          status: 'В работе',
          executor: executorUsername,
          message_id: messageId,
          pizzeria: requestData?.pizzeria,
          problem: requestData?.problem,
          deadline: requestData?.deadline,
          initiator: requestData?.initiator,
          phone: requestData?.phone,
          category: requestData?.category,
          manager: username,
          timestamp: new Date().toISOString()
        });

        return res.sendStatus(200);
      }

      // Done -> start completion flow
      if (data.startsWith('done:')) {
        if (!EXECUTORS.includes(username)) {
          const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут завершать заявки.');
          setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
          return res.sendStatus(200);
        }

        const sheetRowFromData = extractRowFromCallbackData(data);
        const resolvedSheetRow = sheetRowFromData || await findRowByMessageId(messageId);
        if (!resolvedSheetRow) {
          await sendMessage(chatId, '❌ Не удалось найти заявку в таблице.');
          return res.sendStatus(200);
        }

        const stateKey = `${chatId}:${resolvedSheetRow}`;

        const isEmergency = (msg.text || msg.caption || '').includes('🚨') || (msg.caption || '').includes('🚨');

        // create state
        const photoMsg = await sendMessage(
          chatId,
          `📸 Пришлите фото выполненных работ для заявки #${resolvedSheetRow} (обязательно)\n\n⚠️ Для отмены нажмите /cancel`
        );

        userStates[stateKey] = {
          stage: 'waiting_photo',
          row: resolvedSheetRow,
          username,
          userId: user.id,
          chatId,
          messageId,
          originalRequest: parseRequestMessage(msg.text || msg.caption),
          serviceMessages: [photoMsg.data.result.message_id],
          isEmergency
        };

        // timeout
        setTimeout(async () => {
          try {
            if (userStates[stateKey]?.stage === 'waiting_photo') {
              await deleteMessageSafe(chatId, photoMsg.data.result.message_id);
              delete userStates[stateKey];
              await sendMessage(chatId, '⏰ Время ожидания фото истекло.');
            }
          } catch (e) { console.error(e); }
        }, 60000);

        return res.sendStatus(200);
      }

      // Cancel
      if (data.startsWith('cancel:')) {
        if (!EXECUTORS.includes(username)) {
          const notExecutorMsg = await sendMessage(chatId, '❌ Только исполнители могут отменять заявки.');
          setTimeout(() => deleteMessageSafe(chatId, notExecutorMsg.data.result.message_id), 30000);
          return res.sendStatus(200);
        }

        const targetRow = extractRowFromCallbackData(data) || await findRowByMessageId(messageId);
        await sendMessage(chatId, '🚫 Заявка отменена');

        const requestData = parseRequestMessage(msg.text || msg.caption);

        await sendToGAS({
          row: parseInt(targetRow),
          status: 'Отменено',
          executor: username,
          message_id: messageId,
          pizzeria: requestData?.pizzeria,
          problem: requestData?.problem,
          deadline: requestData?.deadline,
          initiator: requestData?.initiator,
          phone: requestData?.phone,
          category: requestData?.category,
          timestamp: new Date().toISOString()
        });

        await sendButtonsWithRetry(chatId, messageId, []);

        return res.sendStatus(200);
      }
    }

    // Handling plain messages (photo, text, etc.)
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const text = msg.text || (msg.caption ? msg.caption : null);
      const messageId = msg.message_id;

      // find an active state for this user in this chat
      let stateKey = null;
      let state = null;
      for (const key of Object.keys(userStates)) {
        const s = userStates[key];
        if (s.chatId === chatId && s.userId === (msg.from.id) && s.stage) {
          stateKey = key;
          state = s;
          break;
        }
      }

      // /cancel command cancels any active state for this user
      if (text === '/cancel' && state) {
        try {
          const svcMsg = state.serviceMessages?.[0];
          if (svcMsg) await deleteMessageSafe(chatId, svcMsg);
        } catch (e) {}
        await sendMessage(chatId, '🚫 Процесс завершения заявки отменен.');
        delete userStates[stateKey];
        return res.sendStatus(200);
      }

      // Photo handling (no reply required)
      if (state?.stage === 'waiting_photo' && msg.photo) {
        try {
          // delete service message
          const svcMsg = state.serviceMessages?.[0];
          if (svcMsg) await deleteMessageSafe(chatId, svcMsg);

          const fileId = msg.photo.at(-1).file_id;
          const fileUrl = await getTelegramFileUrl(fileId);
          if (!fileUrl) {
            await sendMessage(chatId, '❌ Ошибка получения фото. Попробуйте еще раз.');
            return res.sendStatus(200);
          }

          state.photoUrl = fileUrl;
          state.photoDirectUrl = fileUrl;

          // ask for sum
          const sumMsg = await sendMessage(chatId, `💰 Укажите сумму работ по заявке #${state.row} (если отсутствуют — 0). Для отмены /cancel`);
          state.stage = 'waiting_sum';
          state.serviceMessages = [sumMsg.data.result.message_id];

          // timeout for sum
          setTimeout(async () => {
            try {
              if (userStates[stateKey]?.stage === 'waiting_sum') {
                const svc = userStates[stateKey].serviceMessages?.[0];
                if (svc) await deleteMessageSafe(chatId, svc);
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания суммы истекло.');
              }
            } catch (e) { console.error(e); }
          }, 60000);

          return res.sendStatus(200);
        } catch (e) {
          console.error('Error handling photo:', e);
          return res.sendStatus(200);
        }
      }

      // Sum handling (no reply required)
      if (state?.stage === 'waiting_sum' && text) {
        // expecting numeric string but accept any
        try {
          const svcMsg = state.serviceMessages?.[0];
          if (svcMsg) await deleteMessageSafe(chatId, svcMsg);

          state.sum = text;

          const commentMsg = await sendMessage(chatId, `✏️ Комментарий обязателен. Укажите, что было сделано по заявке #${state.row}. Для отмены /cancel`);
          state.stage = 'waiting_comment';
          state.serviceMessages = [commentMsg.data.result.message_id];

          // timeout for comment
          setTimeout(async () => {
            try {
              if (userStates[stateKey]?.stage === 'waiting_comment') {
                const svc = userStates[stateKey].serviceMessages?.[0];
                if (svc) await deleteMessageSafe(chatId, svc);
                delete userStates[stateKey];
                await sendMessage(chatId, '⏰ Время ожидания комментария истекло.');
              }
            } catch (e) { console.error(e); }
          }, 60000);

          return res.sendStatus(200);
        } catch (e) {
          console.error(e);
          return res.sendStatus(200);
        }
      }

      // Comment handling (no reply required)
      if (state?.stage === 'waiting_comment' && text) {
        try {
          const svcMsg = state.serviceMessages?.[0];
          if (svcMsg) await deleteMessageSafe(chatId, svcMsg);

          state.comment = text;

          // Prepare completion data
          const completionData = {
            row: state.row,
            sum: state.sum,
            comment: state.comment,
            photo: state.photoUrl,
            executor: state.username,
            originalRequest: state.originalRequest,
            delayDays: calculateDelayDays(state.originalRequest?.deadline),
            status: 'Выполнено',
            isEmergency: state.isEmergency,
            pizzeria: state.originalRequest?.pizzeria,
            problem: state.originalRequest?.problem,
            deadline: state.originalRequest?.deadline,
            initiator: state.originalRequest?.initiator,
            phone: state.originalRequest?.phone,
            category: state.originalRequest?.category,
            timestamp: new Date().toISOString()
          };

          // Send closure message as reply to original message (messageId stored in state)
          await sendMessage(state.chatId, formatCompletionMessage({ ...completionData, executor: state.username }, state.photoUrl), {
            reply_to_message_id: state.messageId,
            disable_web_page_preview: false
          });

          // Update Google Sheet by message_id (state.messageId)
          try {
            // The sheet row is state.row (we use that)
            const sheetRowNumber = state.row;

            // Map of headers to update (use exactly your column names)
            const updates = {
              'Фото выполненных работ': state.photoUrl || '',
              'Сумма работ по заявке': state.sum || '',
              'Комментарий': state.comment || '',
              'Фактическая дата закрытия заявки': (new Date()).toLocaleString('ru-RU'),
              'Сататус Заявки': 'Закрыта',
              'Исполнитель': state.username || ''
            };

            await updateSheetRowPartial(sheetRowNumber, updates);

            // Optionally call GAS web app
            await sendToGAS({
              row: sheetRowNumber,
              status: 'Выполнено',
              ...completionData
            });

            // After some time try to get disk link from GAS (if implemented) and send update
            setTimeout(async () => {
              if (GAS_WEB_APP_URL) {
                try {
                  const resDisk = await axios.post(`${GAS_WEB_APP_URL}?getDiskLink=true`, { row: sheetRowNumber });
                  const diskUrl = resDisk?.data?.diskLink;
                  if (diskUrl) {
                    await sendMessage(state.chatId, formatCompletionMessage({ ...completionData, executor: state.username }, diskUrl), {
                      reply_to_message_id: state.messageId,
                      disable_web_page_preview: false
                    });
                  }
                } catch (e) { /* ignore */ }
              }
            }, 180000);

          } catch (e) {
            console.error('Error updating sheet:', e);
            await sendMessage(state.chatId, '❌ Ошибка записи в таблицу. Сообщите администратору.');
          }

          // Clear buttons on original message
          try {
            await sendButtonsWithRetry(state.chatId, state.messageId, []);
          } catch (e) {}

          // clear state
          delete userStates[stateKey];
          return res.sendStatus(200);
        } catch (e) {
          console.error('Error on comment processing:', e);
          return res.sendStatus(200);
        }
      }

      // If message is unrelated and no state — do nothing (previously we sent a "reply required" warning; removed per request)
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error && error.stack ? error.stack : error);
    return res.sendStatus(500);
  }
});

// start server (Render handles PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
