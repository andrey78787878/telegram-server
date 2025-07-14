// Конфигурация
const CONFIG = {
  SHEET_ID: '1u48GTrioEVs_3P3fxcX0e7pKZmYwZyE8HioWJHgRZTc',
  SHEET_NAME: 'Заявки',
  BOT_TOKEN: '8005595415:AAHxAw2UlTYwhSiEcMu5CpTBRT_3-epH12Q',
  CHAT_ID: '-1002582747660',
  EXECUTORS: ['@EvelinaB87', '@Olim19', '@Oblayor_04_09', 'Текстовой подрядчик'],
  STATUS_COL: 10, // Колонка статуса (K)
  EXECUTOR_COL: 16, // Колонка исполнителя (P)
  MESSAGE_ID_COL: 17 // Колонка ID сообщения (Q)
};

// Главный обработчик
function doPost(e) {
  try {
    if (!e?.postData?.contents) {
      return createErrorResponse("Invalid request");
    }
    
    const data = JSON.parse(e.postData.contents);
    
    if (data.callback_query) {
      return handleCallback(data.callback_query);
    }
    
    if (data.action) {
      return handleWebhook(data);
    }
    
    return createErrorResponse("No valid data structure found");
  } catch (error) {
    console.error('Error:', error);
    return createErrorResponse(error.message);
  }
}

// Обработка вебхука
function handleWebhook(data) {
  const sheet = getSheet();
  
  switch(data.action) {
    case 'complete':
      return handleComplete(sheet, data);
    case 'in_progress':
      return handleInProgress(sheet, data);
    default:
      return createErrorResponse('Unknown action');
  }
}

// Обработка callback
function handleCallback(callback) {
  try {
    const [action, row, ...rest] = callback.data.split(':');
    const sheet = getSheet();

    switch(action) {
      case 'show_executors':
        return showExecutors(callback, row);
      case 'select_executor':
        return assignExecutor(sheet, callback, row, rest[0]);
      default:
        return createErrorResponse('Unknown callback action');
    }
  } catch (error) {
    console.error('Callback error:', error);
    return createErrorResponse(error.message);
  }
}

// Основные функции
function showExecutors(callback, row) {
  const keyboard = {
    inline_keyboard: CONFIG.EXECUTORS.map(executor => [{
      text: executor,
      callback_data: `select_executor:${row}:${encodeURIComponent(executor)}`
    }])
  };

  editMessage(callback.message.chat.id, callback.message.message_id, {reply_markup: keyboard});
  return createSuccessResponse();
}

function assignExecutor(sheet, callback, row, executor) {
  try {
    const decodedExecutor = decodeURIComponent(executor);
    
    // Обновляем статус и исполнителя
    sheet.getRange(row, CONFIG.EXECUTOR_COL).setValue(decodedExecutor);
    sheet.getRange(row, CONFIG.STATUS_COL).setValue("В работе");
    
    // Убираем кнопки
    editMessage(callback.message.chat.id, callback.message.message_id, {
      reply_markup: {inline_keyboard: []}
    });
    
    // Отправляем подтверждение
    sendMessage(
      callback.message.chat.id, 
      `✅ ${decodedExecutor} назначен на заявку #${row}`,
      callback.message.message_id
    );
    
    return createSuccessResponse();
  } catch (error) {
    console.error('Error assigning executor:', error);
    return createErrorResponse(error.message);
  }
}

// Вспомогательные функции
function getSheet() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  
  if (!sheet) {
    throw new Error(`Sheet ${CONFIG.SHEET_NAME} not found`);
  }
  
  return sheet;
}

function createSuccessResponse(data = {}) {
  return ContentService.createTextOutput(JSON.stringify({ok: true, ...data}))
    .setMimeType(ContentService.MimeType.JSON);
}

function createErrorResponse(message) {
  return ContentService.createTextOutput(JSON.stringify({error: message}))
    .setMimeType(ContentService.MimeType.JSON);
}

// Telegram API функции
function sendMessage(chatId, text, replyTo, replyMarkup) {
  const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  
  if (replyTo) payload.reply_to_message_id = replyTo;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  
  const result = JSON.parse(response.getContentText());
  if (!result.ok) {
    console.error('Telegram API error:', result);
    throw new Error(result.description || 'Telegram API error');
  }
  
  return result;
}

function editMessage(chatId, messageId, params) {
  const url = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/editMessageReplyMarkup`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      ...params
    }),
    muteHttpExceptions: true
  });
  
  const result = JSON.parse(response.getContentText());
  if (!result.ok) {
    console.error('Telegram API edit error:', result);
    throw new Error(result.description || 'Telegram API edit error');
  }
  
  return result;
}

// Триггерная функция для проверки новых заявок
function checkNewRequests() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  
  if (lastRow < 2) return; // Нет данных
  
  const data = sheet.getRange(2, 1, lastRow - 1, 18).getValues();
  
  data.forEach((rowData, index) => {
    const row = index + 2; // +2 потому что header и нумерация с 1
    
    try {
      if (!rowData[CONFIG.EXECUTOR_COL - 1] && rowData[CONFIG.STATUS_COL - 1] === 'в очереди') {
        sendRequestToTelegram(sheet, row, rowData);
        Utilities.sleep(1000); // Задержка между отправками
      }
    } catch (error) {
      console.error(`Error processing row ${row}:`, error);
    }
  });
}

// Функция отправки заявки в Telegram
function sendRequestToTelegram(sheet, row, rowData) {
  const isEmergency = rowData[2] && rowData[2].toString().toLowerCase().includes('аварийная');
  const photoUrl = rowData[14]; // Столбец O (15)
  
  let message = `📍 <b>Заявка #${row}</b>\n\n` +
    `🍕 <b>Пиццерия:</b> ${rowData[1] || '—'}\n` +
    `🔧 <b>Классификация:</b> ${rowData[2] || '—'}\n` +
    `📂 <b>Категория:</b> ${rowData[3] || '—'}\n` +
    `📋 <b>Проблема:</b> ${rowData[4] || '—'}\n` +
    `👤 <b>Инициатор:</b> ${rowData[5] || '—'}\n` +
    `📞 <b>Телефон:</b> ${rowData[6] || '—'}\n` +
    `📸 <b>Фото проблемы:</b> ${photoUrl ? `<a href="${photoUrl}">Ссылка</a>` : 'нет'}\n` +
    `🕓 <b>Срок:</b> ${rowData[8] ? Utilities.formatDate(new Date(rowData[8]), "GMT+5", "dd.MM.yyyy") : '—'}`;

  if (isEmergency) {
    message = `🚨🚨🚨 <b>АВАРИЙНАЯ ЗАЯВКА!</b> 🚨🚨🚨\n\n${message}`;
    sheet.getRange(row, 1, 1, 18).setBackground('#FFCCCC');
  }

  const keyboard = {
    inline_keyboard: [[{
      text: 'Принять в работу',
      callback_data: `show_executors:${row}`
    }]]
  };

  try {
    const response = sendMessage(CONFIG.CHAT_ID, message, null, keyboard);
    
    sheet.getRange(row, CONFIG.MESSAGE_ID_COL).setValue(response.result.message_id);
    sheet.getRange(row, CONFIG.STATUS_COL).setValue('отправлено');
  } catch (error) {
    console.error(`Error sending request #${row}:`, error);
    sheet.getRange(row, CONFIG.STATUS_COL).setValue('ошибка отправки');
  }
}
