/* ---------------------------------- Импорт ---------------------------------- */

const axios = require('axios');
const FormData = require('form-data'); // оставляю, как в твоём файле, на будущее

/* ------------------------------ Конфигурация ------------------------------- */

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;

/**
 * Права пользователей (оставлено как у тебя).
 * Можно расширять списки без изменения кода ниже.
 */
const MANAGERS = ['@Andrey_Tkach_MB', '@Davr_85', '@EvelinaB87'];
const EXECUTORS = ['@Andrey_Tkach_MB', '@Olim19', '@Davr_85', '@Oblayor_04_09', '@IkromovichV', '@EvelinaB87'];
const AUTHORIZED_USERS = [...new Set([...MANAGERS, ...EXECUTORS])];

/* -------------------------- Память процесса (RAM) -------------------------- */

/** Хранилище соответствий username -> Telegram user_id */
const userStorage = new Map();

/**
 * Хранилище диалоговых состояний, по chatId:
 * state = {
 *   stage: 'waiting_photo' | 'waiting_sum' | 'waiting_comment',
 *   row: number,
 *   username: '@name',
 *   messageId: number, // id "материнского" сообщения с кнопками
 *   originalRequest: {...}, // распарсенные поля заявки из текста
 *   serviceMessages: number[], // id сервисных сообщений, чтобы удалять
 *   isEmergency: boolean,
 *   photoUrl?: string,
 *   sum?: string,
 *   comment?: string
 * }
 */
const userStates = Object.create(null);

/* --------------------------------- Утилиты --------------------------------- */

/** Строгий префикс '@' у username */
function normalizeUsername(maybeUsername) {
  if (!maybeUsername) return null;
  const s = String(maybeUsername).trim();
  if (!s) return null;
  return s.startsWith('@') ? s : `@${s}`;
}

/** Простой логгер с ISO-временем */
function logInfo(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}
function logWarn(...args) {
  console.warn(new Date().toISOString(), '-', ...args);
}
function logError(...args) {
  console.error(new Date().toISOString(), '-', ...args);
}

/** Безопасная пауза (await delay(ms)) */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------- Вспомогательные ф-ии ---------------------------- */

/**
 * Извлекаем номер строки из callback_data вида 'executor:@user:123' или 'done:123'
 */
function extractRowFromCallbackData(callbackData) {
  if (!callbackData || typeof callbackData !== 'string') return null;
  const parts = callbackData.split(':');
  if (parts.length < 2) return null;
  const maybe = parts[parts.length - 1];
  const row = parseInt(maybe, 10);
  return Number.isFinite(row) ? row : null;
}

/** Извлекаем #<номер> из текста сообщения */
function extractRowFromMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Парсер карточки заявки из текста.
 * Сохраняю твою логику построчного поиска по префиксам.
 */
function parseRequestMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const result = {};
  const lines = text.split('\n');

  lines.forEach((line) => {
    if (line.includes('Пиццерия:')) result.pizzeria = line.split(':')[1]?.trim();
    if (line.includes('Категория:')) result.category = line.split(':')[1]?.trim();
    if (line.includes('Проблема:')) result.problem = line.split(':')[1]?.trim();
    if (line.includes('Инициатор:')) result.initiator = line.split(':')[1]?.trim();
    if (line.includes('Телефон:')) result.phone = line.split(':')[1]?.trim();
    if (line.includes('Срок:')) result.deadline = line.split(':')[1]?.trim();
  });

  return result;
}

/** Считаем просрочку в днях относительно deadline */
function calculateDelayDays(deadline) {
  if (!deadline) return 0;
  try {
    const deadlineDate = new Date(deadline);
    if (isNaN(+deadlineDate)) return 0;
    const today = new Date();
    const diffTime = today - deadlineDate;
    return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
  } catch (e) {
    logError('Error calculating delay:', e);
    return 0;
  }
}

/** Формирование финального текста закрытия (оставил как было, немного упорядочил) */
function formatCompletionMessage(data, diskUrl = null) {
  const photoLink = diskUrl ? diskUrl : data.photoUrl ? data.photoUrl : null;
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

/* -------------------------- Обёртки Telegram API -------------------------- */

/** Отправка сообщения (HTML parse_mode по умолчанию сохранён) */
async function sendMessage(chatId, text, options = {}) {
  try {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options,
    };
    const resp = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return resp;
  } catch (error) {
    logError('Send message error:', error.response?.data || error.message);
    throw error;
  }
}

/** Безопасное редактирование текста сообщения */
async function editMessageSafe(chatId, messageId, text, options = {}) {
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...options,
    };
    return await axios.post(`${TELEGRAM_API}/editMessageText`, payload);
  } catch (error) {
    const desc = error.response?.data?.description || '';
    if (desc.includes('no text in the message') || desc.includes('message to edit not found')) {
      // Если исходник не редактируем — шлём новое
      return await sendMessage(chatId, text, options);
    }
    logError('Edit message error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Установка/замена inline-кнопок. Если Telegram отвечает «not modified» — игнорируем.
 * Если редактировать нельзя — отправляем новое сообщение-заглушку с кнопками.
 */
async function sendButtonsWithRetry(chatId, messageId, buttons, fallbackText) {
  try {
    const resp = await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons },
    });
    return resp;
  } catch (error) {
    const desc = error.response?.data?.description || '';
    if (desc.includes('not modified')) {
      return { ok: true };
    }
    // Если не получилось отредактировать, отправим новое сообщение с этими кнопками
    return await sendMessage(chatId, fallbackText || ' ', {
      reply_markup: { inline_keyboard: buttons },
    });
  }
}

/**
 * Снять inline-кнопки у существующего сообщения (удалить клавиатуру).
 * Используем editMessageReplyMarkup с пустым объектом, как рекомендует Telegram.
 */
async function clearInlineKeyboard(chatId, messageId) {
  try {
    return await axios.post(`${TELEGRAM_API}/editMessageReplyMarkup`, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {}, // пустой объект — удаляет клавиатуру
    });
  } catch (error) {
    const desc = error.response?.data?.description || '';
    // Если сообщение удалено/не найдено — это не критично
    if (
      desc.includes('message to edit not found') ||
      desc.includes('Bad Request: message is not modified')
    ) {
      return { ok: false, ignored: true };
    }
    logWarn('clearInlineKeyboard error:', error.response?.data || error.message);
    return { ok: false, ignored: false, error };
  }
}

/** Безопасное удаление сообщения: 400/404 — не фатально */
async function deleteMessageSafe(chatId, messageId) {
  if (!chatId || !messageId) return null;
  try {
    return await axios.post(`${TELEGRAM_API}/deleteMessage`, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (error) {
    const data = error.response?.data;
    // Эти ошибки нередки, когда сообщение уже удалено/зачищено
    if (data?.description && data.description.includes('message to delete not found')) {
      logWarn('Delete message warning (not found):', { chatId, messageId });
      return null;
    }
    logWarn('Delete message error:', data || error.message);
    return null;
  }
}

/** Получение публичного URL файла Telegram по file_id */
async function getTelegramFileUrl(fileId) {
  if (!fileId) return null;
  try {
    const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const path = data?.result?.file_path;
    if (!path) return null;
    return `${TELEGRAM_FILE_API}/${path}`;
  } catch (error) {
    logWarn('Get file URL error:', error.response?.data || error.message);
    return null;
  }
}

/* ------------------------------ GAS-интеграция ------------------------------ */

async function sendToGAS(data) {
  try {
    logInfo('Sending to GAS:', JSON.stringify(data));
    const response = await axios.post(GAS_WEB_APP_URL, data);
    logInfo('Data sent to GAS, status:', response.status);
    return response.data;
  } catch (error) {
    logError('Error sending to GAS:', error.message);
    throw error;
  }
}

async function getGoogleDiskLink(row) {
  try {
    const res = await axios.post(`${GAS_WEB_APP_URL}?getDiskLink=true`, { row });
    return res.data?.diskLink || null;
  } catch (error) {
    logWarn('Get Google Disk link error:', error.response?.data || error.message);
    return null;
  }
}

/* ---------------------------- Валидации/Проверки ---------------------------- */

function isEmergencyText(text) {
  if (!text) return false;
  return text.includes('🚨') || text.includes('АВАРИЙНАЯ');
}

function isManager(username) {
  const u = normalizeUsername(username);
  return !!u && MANAGERS.includes(u);
}

function isExecutor(username) {
  const u = normalizeUsername(username);
  return !!u && EXECUTORS.includes(u);
}

function isAuthorized(username) {
  const u = normalizeUsername(username);
  return !!u && AUTHORIZED_USERS.includes(u);
}

/* -------------------------- Общие шаблоны сообщений ------------------------- */

function buildAssignExecutorKeyboard(row) {
  return EXECUTORS.map((e) => [{ text: e, callback_data: `executor:${e}:${row}` }]);
}

function buildActionsKeyboard(row) {
  return [
    [
      { text: '✅ Выполнено', callback_data: `done:${row}` },
      { text: '⏳ Ожидает', callback_data: `wait:${row}` },
      { text: '❌ Отмена', callback_data: `cancel:${row}` },
    ],
  ];
}

/* ------------------------------ Обработчики ------------------------------ */

/**
 * Уведомление менеджеров об аварийной заявке, когда она впервые поступает в чат.
 * Срабатывает на новые сообщения с 🚨/АВАРИЙНАЯ (сохраняю твою логику).
 */
async function maybeDuplicateEmergencyToManagersIfNeeded(msg) {
  try {
    const text = msg?.text || msg?.caption || '';
    if (!text) return;

    if (isEmergencyText(text)) {
      const requestData = parseRequestMessage(text);
      const row = extractRowFromMessage(text);

      if (!row) return;

      for (const manager of MANAGERS) {
        const managerId = userStorage.get(manager);
        if (!managerId) continue;
        try {
          await sendMessage(
            managerId,
            `🚨 ПОСТУПИЛА АВАРИЙНАЯ ЗАЯВКА #${row}\n\n` +
              `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
              `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
              `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
              `‼️ ТРЕБУЕТСЯ ВАШЕ ВНИМАНИЕ!`,
            { disable_notification: false }
          );
        } catch (e) {
          logWarn(`Error sending emergency to ${manager}:`, e?.response?.data || e.message);
        }
      }
    }
  } catch (e) {
    logWarn('maybeDuplicateEmergencyToManagersIfNeeded error:', e.message);
  }
}

/**
 * Сброс диалогового состояния по chatId
 */
function resetState(chatId) {
  if (chatId && userStates[chatId]) {
    delete userStates[chatId];
  }
}

/**
 * Безопасное удаление всех сервисных сообщений из состояния
 */
async function cleanupServiceMessages(chatId, state) {
  if (!state?.serviceMessages?.length) return;
  await Promise.all(
    state.serviceMessages.map((mid) => deleteMessageSafe(chatId, mid).catch(() => null))
  );
  state.serviceMessages = [];
}

/* -------------------------------- Экспорт --------------------------------- */

module.exports = (app) => {
  /**
   * Единая точка входа для Telegram webhook
   */
  app.post('/webhook', async (req, res) => {
    // Оборачиваем весь webhook в try/catch, как у тебя
    try {
      const body = req.body;

      /* ------------------------------ message.from ------------------------------ */
      // Всегда сохраняем user_id автора сообщения (для ЛС-уведомлений)
      if (body?.message?.from) {
        const userFrom = body.message.from;
        if (userFrom?.username) {
          const key = normalizeUsername(userFrom.username);
          if (key) userStorage.set(key, userFrom.id);
        }

        // Доп. логика: дублирование аварийной заявки менеджерам (как у тебя)
        const msg = body.message;
        await maybeDuplicateEmergencyToManagersIfNeeded(msg);
      }

      /* ------------------------------ callback_query ----------------------------- */
      if (body?.callback_query) {
        const { callback_query } = body;
        const fromUser = callback_query.from || {};
        const msg = callback_query.message || {};
        const chatId = msg?.chat?.id;
        const messageId = msg?.message_id;
        const rawUsername = fromUser?.username ? `@${fromUser.username}` : null;
        const username = normalizeUsername(rawUsername);
        const data = callback_query.data || '';

        // Сохраняем user_id автора нажатия
        if (fromUser?.username) {
          const key = normalizeUsername(fromUser.username);
          if (key) userStorage.set(key, fromUser.id);
        }

        // Отвечаем на callback, чтобы Telegram убрал "крутилку"
        axios
          .post(`${TELEGRAM_API}/answerCallbackQuery`, {
            callback_query_id: callback_query.id,
          })
          .catch((e) => logWarn('Answer callback error:', e?.response?.data || e.message));

        // Номер заявки
        const rowFromCb = extractRowFromCallbackData(data);
        const rowFromText = extractRowFromMessage(msg?.text || msg?.caption || '');
        const row = Number.isFinite(rowFromCb) ? rowFromCb : rowFromText;

        if (!Number.isFinite(row)) {
          logWarn('Не удалось извлечь номер заявки из callback_query:', data);
          if (chatId) {
            const accessMsg = await sendMessage(chatId, '❌ Ошибка: не найден номер заявки');
            // Удалим через 30 сек
            setTimeout(
              () => deleteMessageSafe(chatId, accessMsg?.data?.result?.message_id),
              30_000
            );
          }
          return res.sendStatus(200);
        }

        // Проверка прав
        if (!isAuthorized(username)) {
          if (chatId) {
            const accessDeniedMsg = await sendMessage(chatId, '❌ У вас нет доступа.');
            setTimeout(
              () => deleteMessageSafe(chatId, accessDeniedMsg?.data?.result?.message_id),
              30_000
            );
          }
          return res.sendStatus(200);
        }

        /* ------------------------ Кнопка "Принять в работу" ------------------------ */
        if (data.startsWith('accept')) {
          if (!isManager(username)) {
            if (chatId) {
              const notManagerMsg = await sendMessage(
                chatId,
                '❌ Только менеджеры могут назначать заявки.'
              );
              setTimeout(
                () => deleteMessageSafe(chatId, notManagerMsg?.data?.result?.message_id),
                30_000
              );
            }
            return res.sendStatus(200);
          }

          const isEmergency = isEmergencyText(msg?.text || msg?.caption || '');
          const requestData = parseRequestMessage(msg?.text || msg?.caption || '');

          if (isEmergency) {
            // 1) Уведомим всех менеджеров (кроме нажавшего)
            for (const manager of MANAGERS) {
              const managerId = userStorage.get(manager);
              if (!managerId || managerId === fromUser.id) continue;

              try {
                await sendMessage(
                  managerId,
                  `🚨 МЕНЕДЖЕР ${username} ПРИНЯЛ АВАРИЙНУЮ ЗАЯВКУ #${row}\n\n` +
                    `🏢 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                    `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                    `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                    `‼️ ТРЕБУЕТСЯ КОНТРОЛЬ!`,
                  { disable_notification: false }
                );
              } catch (e) {
                logWarn(`Error sending to manager ${manager}:`, e?.response?.data || e.message);
              }
            }

            // 2) Выбор исполнителя
            const buttons = buildAssignExecutorKeyboard(row);

            const chooseExecutorMsg = await sendMessage(
              chatId,
              `🚨 АВАРИЙНАЯ ЗАЯВКА - выберите исполнителя #${row}:`,
              { reply_to_message_id: messageId }
            );

            // Через минуту убрать сервисное "выберите исполнителя" (если оно есть)
            setTimeout(async () => {
              try {
                await deleteMessageSafe(chatId, chooseExecutorMsg?.data?.result?.message_id);
              } catch (e) {
                logWarn('Error deleting choose executor message:', e.message);
              }
            }, 60_000);

            // Поставим клавиатуру на материнское сообщение
            await sendButtonsWithRetry(
              chatId,
              messageId,
              buttons,
              `Выберите исполнителя для аварийной заявки #${row}:`
            );

            // Отправим статус в GAS
            await sendToGAS({
              row,
              status: 'Аварийная',
              message_id: messageId,
              isEmergency: true,
              pizzeria: requestData?.pizzeria,
              problem: requestData?.problem,
              deadline: requestData?.deadline,
              initiator: requestData?.initiator,
              phone: requestData?.phone,
              category: requestData?.category,
              manager: username,
              timestamp: new Date().toISOString(),
            });

            return res.sendStatus(200);
          }

          // Обычная заявка: просто предлагаем выбрать исполнителя
          {
            const buttons = buildAssignExecutorKeyboard(row);

            const chooseExecutorMsg = await sendMessage(
              chatId,
              `👷 Выберите исполнителя для заявки #${row}:`,
              { reply_to_message_id: messageId }
            );

            setTimeout(async () => {
              try {
                await deleteMessageSafe(chatId, chooseExecutorMsg?.data?.result?.message_id);
              } catch (e) {
                logWarn('Error deleting choose executor message:', e.message);
              }
            }, 60_000);

            await sendButtonsWithRetry(
              chatId,
              messageId,
              buttons,
              `Выберите исполнителя для заявки #${row}:`
            );

            const requestData = parseRequestMessage(msg?.text || msg?.caption || '');
            await sendToGAS({
              row,
              status: 'Принята в работу',
              message_id: messageId,
              pizzeria: requestData?.pizzeria,
              problem: requestData?.problem,
              deadline: requestData?.deadline,
              initiator: requestData?.initiator,
              phone: requestData?.phone,
              category: requestData?.category,
              manager: username,
              timestamp: new Date().toISOString(),
            });

            return res.sendStatus(200);
          }
        }

        /* --------------------------- Выбор исполнителя --------------------------- */
        if (data.startsWith('executor:')) {
          const parts = data.split(':');
          // executor:@UserName:<row>
          const executorUsernameRaw = parts[1] || '';
          const executorUsername = normalizeUsername(executorUsernameRaw);
          const requestData = parseRequestMessage(msg?.text || msg?.caption || '');

          // Удаляем сервисное сообщение "Выберите исполнителя", если оно есть
          if (msg?.reply_to_message?.message_id) {
            await deleteMessageSafe(chatId, msg.reply_to_message.message_id);
          }

          // Меняем кнопки на действия
          const actionButtons = buildActionsKeyboard(row);
          await sendButtonsWithRetry(
            chatId,
            messageId,
            actionButtons,
            `Выберите действие для заявки #${row}:`
          );

          // Сообщение в чат (ответом на материнское)
          await sendMessage(
            chatId,
            `📢 ${executorUsername}, вам назначена заявка #${row}!`,
            { reply_to_message_id: messageId }
          );

          // Дублируем в ЛС исполнителю (если знаем его user_id)
          try {
            const executorId = userStorage.get(executorUsername);
            if (executorId) {
              await sendMessage(
                executorId,
                `📌 Вам назначена заявка #${row}\n\n` +
                  `🍕 Пиццерия: ${requestData?.pizzeria || 'не указано'}\n` +
                  `🔧 Проблема: ${requestData?.problem || 'не указано'}\n` +
                  `🕓 Срок: ${requestData?.deadline || 'не указан'}\n\n` +
                  `⚠️ Приступайте к выполнению`,
                { parse_mode: 'HTML' }
              );
            } else {
              logWarn('❗ Не найден executorId для', executorUsername);
            }
          } catch (e) {
            logWarn('Ошибка отправки уведомления в ЛС:', e.message);
          }

          await sendToGAS({
            row,
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
            timestamp: new Date().toISOString(),
          });

          return res.sendStatus(200);
        }

        /* ------------------------------ Завершение ------------------------------ */
        if (data.startsWith('done:')) {
          if (!isExecutor(username)) {
            const notExecutorMsg = await sendMessage(
              chatId,
              '❌ Только исполнители могут завершать заявки.'
            );
            setTimeout(
              () => deleteMessageSafe(chatId, notExecutorMsg?.data?.result?.message_id),
              90_000
            );
            return res.sendStatus(200);
          }

          // Просим фото
          const photoMsg = await sendMessage(
            chatId,
            '📸 Пришлите фото выполненных работ\n\n' + '⚠️ Для отмены нажмите /cancel',
            { reply_to_message_id: messageId }
          );

          // Ставим состояние
          userStates[chatId] = {
            stage: 'waiting_photo',
            row: parseInt(data.split(':')[1], 10),
            username,
            messageId,
            originalRequest: parseRequestMessage(msg?.text || msg?.caption || ''),
            serviceMessages: [photoMsg?.data?.result?.message_id].filter(Boolean),
            isEmergency: isEmergencyText(msg?.text || msg?.caption || ''),
          };

          // Через 2 минуты удалим подсказку про фото
          setTimeout(() => {
            const mid = photoMsg?.data?.result?.message_id;
            deleteMessageSafe(chatId, mid).catch(() => {});
          }, 120_000);

          return res.sendStatus(200);
        }

        /* --------------------------- Ожидание поставки --------------------------- */
        if (data.startsWith('wait:')) {
          if (!isExecutor(username)) {
            const notExecutorMsg = await sendMessage(
              chatId,
              '❌ Только исполнители могут менять статус заявки.'
            );
            setTimeout(
              () => deleteMessageSafe(chatId, notExecutorMsg?.data?.result?.message_id),
              90_000
            );
            return res.sendStatus(200);
          }

          await sendMessage(chatId, '⏳ Заявка переведена в статус "Ожидает поставки"', {
            reply_to_message_id: messageId,
          });

          const requestData = parseRequestMessage(msg?.text || msg?.caption || '');

          await sendToGAS({
            row: parseInt(data.split(':')[1], 10),
            status: 'Ожидает поставки',
            executor: username,
            message_id: messageId,
            pizzeria: requestData?.pizzeria,
            problem: requestData?.problem,
            deadline: requestData?.deadline,
            initiator: requestData?.initiator,
            phone: requestData?.phone,
            category: requestData?.category,
            timestamp: new Date().toISOString(),
          });

          return res.sendStatus(200);
        }

        /* -------------------------------- Отмена -------------------------------- */
        if (data.startsWith('cancel:')) {
          if (!isExecutor(username)) {
            const notExecutorMsg = await sendMessage(
              chatId,
              '❌ Только исполнители могут отменять заявки.'
            );
            setTimeout(
              () => deleteMessageSafe(chatId, notExecutorMsg?.data?.result?.message_id),
              30_000
            );
            return res.sendStatus(200);
          }

          await sendMessage(chatId, '🚫 Заявка отменена', { reply_to_message_id: messageId });

          const requestData = parseRequestMessage(msg?.text || msg?.caption || '');

          await sendToGAS({
            row: parseInt(data.split(':')[1], 10),
            status: 'Отменено',
            executor: username,
            message_id: messageId,
            pizzeria: requestData?.pizzeria,
            problem: requestData?.problem,
            deadline: requestData?.deadline,
            initiator: requestData?.initiator,
            phone: requestData?.phone,
            category: requestData?.category,
            timestamp: new Date().toISOString(),
          });

          return res.sendStatus(200);
        }
      }

      /* ----------------------- Обычные сообщения (message) ----------------------- */

      /**
       * Обработка этапов сбора: фото -> сумма -> комментарий
       * Сценарий полностью оставлен как у тебя, но:
       *  - Добавлена очистка инлайн-кнопок через clearInlineKeyboard
       *  - Добавлены /cancel и защитные проверки
       */
      if (body?.message && userStates[body.message.chat.id]) {
        (async () => {
          const msg = body.message;
          const chatId = msg?.chat?.id;
          const state = userStates[chatId];

          try {
            // /cancel — сброс на любой стадии
            if (msg?.text && msg.text.trim() === '/cancel') {
              await cleanupServiceMessages(chatId, state);
              await sendMessage(chatId, '❎ Операция отменена. Статус не изменён.', {
                reply_to_message_id: state?.messageId,
              });
              resetState(chatId);
              return res.sendStatus(200);
            }

            /* --------------------------- Получение фото --------------------------- */
            if (state?.stage === 'waiting_photo' && (msg?.photo || msg?.document)) {
              // Удаляем приглашение «Пришлите фото»
              await cleanupServiceMessages(chatId, state);

              // Берём лучшее качество фото
              let fileId = null;
              if (Array.isArray(msg.photo) && msg.photo.length > 0) {
                const best = msg.photo[msg.photo.length - 1];
                fileId = best?.file_id || best?.fileId || null;
              } else if (msg.document && /^image\//.test(msg.document.mime_type || '')) {
                fileId = msg.document.file_id;
              }

              state.photoUrl = await getTelegramFileUrl(fileId);

              // Запрашиваем сумму
              const sumMsg = await sendMessage(chatId, '💰 Укажите сумму работ (в сумах)');
              state.stage = 'waiting_sum';
              state.serviceMessages = [sumMsg?.data?.result?.message_id].filter(Boolean);

              setTimeout(() => {
                const mid = sumMsg?.data?.result?.message_id;
                deleteMessageSafe(chatId, mid).catch(() => {});
              }, 120_000);

              return res.sendStatus(200);
            }

            /* --------------------------- Получение суммы --------------------------- */
            if (state?.stage === 'waiting_sum' && msg?.text) {
              await cleanupServiceMessages(chatId, state);

              // Можно добавить валидацию суммы, но сохраняю как есть (строка)
              state.sum = msg.text.trim();

              const commentMsg = await sendMessage(chatId, '💬 Напишите комментарий');
              state.stage = 'waiting_comment';
              state.serviceMessages = [commentMsg?.data?.result?.message_id].filter(Boolean);

              setTimeout(() => {
                const mid = commentMsg?.data?.result?.message_id;
                deleteMessageSafe(chatId, mid).catch(() => {});
              }, 120_000);

              return res.sendStatus(200);
            }

            /* ------------------------ Получение комментария ------------------------ */
            if (state?.stage === 'waiting_comment' && msg?.text) {
              await cleanupServiceMessages(chatId, state);

              state.comment = msg.text.trim();

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
                timestamp: new Date().toISOString(),
              };

              // 1) Снимаем кнопки у материнской заявки
              await clearInlineKeyboard(chatId, state.messageId);

              // 2) Отправляем данные в GAS
              await sendToGAS(completionData);

              // 3) Финальный текст (оставляю формирование как у тебя, только вынесено в функцию)
              const finalText = [
                `✅ Заявка #${state.row} закрыта`,
                `📸 ${state.photoUrl || 'нет фото'}`,
                `💬 Комментарий: ${state.comment || 'нет комментария'}`,
                `💰 Сумма: ${state.sum || '0'} сум`,
                `👤 Исполнитель: ${state.username}`,
                completionData.delayDays > 0 ? `🔴 Просрочка: ${completionData.delayDays} дн.` : '',
                '━━━━━━━━━━━━',
                `🏢 Пиццерия: ${state.originalRequest?.pizzeria || 'не указано'}`,
                `🔧 Проблема: ${state.originalRequest?.problem || 'не указано'}`,
              ]
                .filter(Boolean)
                .join('\n');

              // 4) Отправим финальное сообщение ответом на материнское
              await sendMessage(chatId, finalText, { reply_to_message_id: state.messageId });

              // 5) Через 3 минуты запросим ссылку с диска и обновим «материнское» сообщение
              setTimeout(async () => {
                try {
                  const diskUrlUpdate = await getGoogleDiskLink(state.row);
                  if (diskUrlUpdate) {
                    await editMessageSafe(
                      chatId,
                      state.messageId,
                      formatCompletionMessage(completionData, diskUrlUpdate),
                      { disable_web_page_preview: false }
                    );
                  }
                } catch (e) {
                  logWarn('Error updating disk link:', e.message);
                }
              }, 180_000);

              // 6) Сбросим состояние
              resetState(chatId);

              return res.sendStatus(200);
            }

            // Если сообщение не соответствует ожидаемой стадии — просто игнорируем
            return res.sendStatus(200);
          } catch (error) {
            logError('Webhook error (message state flow):', error.message);
            return res.sendStatus(500);
          }
        })();
      }

      /* ------------------------ Команда /cancel вне стейта ----------------------- */
      // Если пользователь прислал /cancel без активного состояния — просто дружелюбный ответ
      if (body?.message?.text === '/cancel') {
        const chatId = body.message.chat.id;
        await sendMessage(chatId, 'ℹ️ Нет активной операции для отмены.');
        return res.sendStatus(200);
      }

      // Если ни одна ветка не сработала — просто 200
      return res.sendStatus(200);
    } catch (e) {
      logError('Webhook outer error:', e.message);
      return res.sendStatus(500);
    }
  });
};

/* -------------------------------- Конец файла --------------------------------

Сводка сделанных улучшений, чтобы упростить отладку:
- Везде normalizeUsername для согласованности ключей в userStorage.
- clearInlineKeyboard вместо передачи [] в sendButtonsWithRetry (это корректнее).
- deleteMessageSafe не падает на "message to delete not found".
- Ветка executor: добавлена нормализация executorUsername + проверка userStorage.
- Добавлены таймауты с безопасной очисткой сервисных сообщений.
- Защита /cancel на любой стадии (и вне стейта — дружественный ответ).
- Доп. логгирование, чтобы на Render проще было понимать последовательность событий.

*/ 
```
