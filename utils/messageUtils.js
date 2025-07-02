function buildInlineKeyboard(buttons) {
  return {
    reply_markup: {
      inline_keyboard: buttons,
    },
  };
}

function deleteAfterDelay(bot, chatId, messageId, delay = 60000) {
  setTimeout(() => {
    bot.deleteMessage(chatId, messageId).catch((err) => {
      console.log(`Не удалось удалить сообщение ${messageId}:`, err.description);
    });
  }, delay);
}

function formatFinalMessage({ id, sum, executor, overdue, photoUrl }) {
  return `
📌 Заявка #${id} закрыта.
📎 Фото: ${photoUrl}
💰 Сумма: ${sum} сум
👤 Исполнитель: ${executor}
✅ Статус: Выполнено
Просрочка: ${overdue} дн.
  `;
}

module.exports = {
  buildInlineKeyboard,
  deleteAfterDelay,
  formatFinalMessage,
};
