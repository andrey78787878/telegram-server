function buildInitialMessage(rowData, rowIndex) {
  const [
    timestamp, pizzeriaNumber, classification, category, problemDescription,
    initiator, phoneNumber, photoUrl, deadline
  ] = rowData;

  return `
📌 *Заявка #${rowIndex}*
🏪 *Пиццерия:* ${pizzeriaNumber}
🛠 *Категория:* ${category}
📂 *Классификация:* ${classification}
📎 *Суть:* ${problemDescription}
👤 *Инициатор:* ${initiator}
📞 *Телефон:* ${phoneNumber}
🕒 *Срок:* ${deadline || 'не указан'}
  `.trim();
}

function buildInitialButtons(messageId) {
  return {
    inline_keyboard: [
      [
        {
          text: 'Принято в работу',
          callback_data: `in_progress_${messageId}`,
        },
      ],
    ],
  };
}

function buildFollowUpButtons(messageId) {
  return {
    inline_keyboard: [
      [
        { text: 'Выполнено ✅', callback_data: `completed_${messageId}` },
        { text: 'Ожидает поставки ⏳', callback_data: `delayed_${messageId}` },
        { text: 'Отмена ❌', callback_data: `cancelled_${messageId}` },
      ],
    ],
  };
}

function buildInProgressMessage(rowIndex, executorUsername, problemDescription) {
  return `
🟢 Заявка #${rowIndex} в работе.
👤 *Исполнитель:* @${executorUsername}
📌 *Суть:* ${problemDescription}
  `.trim();
}

function buildFinalClosedMessage({ rowIndex, photoUrl, sum, executor, overdueDays }) {
  return `
📌 *Заявка #${rowIndex} закрыта.*
📎 [Фото](${photoUrl})
💰 *Сумма:* ${sum} сум
👤 *Исполнитель:* @${executor}
✅ *Статус:* Выполнено
⏰ *Просрочка:* ${overdueDays || 0} дн.
  `.trim();
}

module.exports = {
  buildInitialMessage,
  buildInitialButtons,
  buildFollowUpButtons,
  buildInProgressMessage,
  buildFinalClosedMessage,
};
