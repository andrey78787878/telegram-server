async function completeRequest(chatId, text, messageId, state) {
    try {
        // Проверяем наличие всех обязательных данных
        const requiredFields = ['executor', 'photoUrl', 'amount'];
        const missingFields = requiredFields.filter(field => !state[field]);
        
        if (missingFields.length > 0) {
            throw new Error(`Отсутствуют обязательные данные: ${missingFields.join(', ')}`);
        }

        // Получаем оригинальный текст заявки
        const originalTextRes = await axios.post(GAS_WEB_APP_URL, {
            action: 'getRequestText',
            row: state.row
        });
        
        const originalText = originalTextRes.data?.text || '';
        
        // Формируем обновленный текст
        const updatedText = `✅ Выполнено\n` +
            `👷 Исполнитель: ${state.executor}\n` +
            `💰 Сумма: ${state.amount}\n` +
            `📸 Фото: ${state.photoUrl ? 'есть' : 'отсутствует'}\n` +
            `📝 Комментарий: ${text || 'не указан'}\n\n` +
            `━━━━━━━━━━━━\n${originalText}`;

        // Подготавливаем данные для GAS
        const gasData = {
            action: 'complete',
            row: state.row,
            photoUrl: state.photoUrl,
            amount: state.amount,
            comment: text,  // Используем переданный текст как комментарий
            executor: state.executor,
            message_id: state.originalMessageId
        };

        console.log('Отправка данных в Google Sheets:', gasData);
        
        // Отправляем данные в Google Sheets
        const gasResponse = await axios.post(GAS_WEB_APP_URL, gasData);
        
        if (gasResponse.data?.error) {
            throw new Error(gasResponse.data.error);
        }

        // Обновляем сообщение
        await editMessageText(chatId, state.originalMessageId, updatedText);
        
        // Удаляем временные сообщения
        await cleanupMessages(chatId, state);
        
        // Очищаем состояние
        delete userStates[chatId];
        
    } catch (error) {
        console.error('Ошибка при завершении заявки:', error);
        await sendMessage(chatId, `⚠️ Ошибка при завершении заявки: ${error.message}`);
        // Не очищаем состояние при ошибке, чтобы можно было повторить
    }
}

// Обновленный обработчик callback_query
if (action === 'select_executor') {
    if (!userStates[chatId]) userStates[chatId] = {};

    if (executor === 'Текстовой подрядчик') {
        userStates[chatId].awaiting_manual_executor = true;
        const prompt = await sendMessage(chatId, 'Введите имя подрядчика:');
        userStates[chatId].serviceMessages = [prompt];
        return;
    }

    try {
        const [originalIdRes, originalTextRes] = await Promise.all([
            axios.post(GAS_WEB_APP_URL, { action: 'getMessageId', row }),
            axios.post(GAS_WEB_APP_URL, { action: 'getRequestText', row })
        ]);

        const originalMessageId = originalIdRes.data?.message_id;
        const originalText = originalTextRes.data?.text || '';

        if (!originalMessageId) {
            throw new Error('Не удалось получить message_id');
        }

        // Обновляем Google Sheets
        await axios.post(GAS_WEB_APP_URL, { 
            action: 'in_progress', 
            row, 
            executor, 
            message_id: originalMessageId 
        });

        // Обновляем состояние
        userStates[chatId] = {
            ...userStates[chatId],
            executor,  // Сохраняем исполнителя!
            row,
            originalMessageId,
            sourceMessageId: messageId,
            serviceMessages: [],
            userResponses: []
        };

        const updatedText = `${originalText}\n\n🟢 В работе\n👷 Исполнитель: ${executor}`;
        const buttons = {
            inline_keyboard: [
                [
                    { text: '✅ Выполнено', callback_data: `done:${row}` },
                    { text: '⏳ Ожидает поставки', callback_data: `delayed:${row}` },
                    { text: '❌ Отмена', callback_data: `cancelled:${row}` }
                ]
            ]
        };

        await editMessageText(chatId, originalMessageId, updatedText, buttons);
        
    } catch (error) {
        console.error('Ошибка при выборе исполнителя:', error);
        await sendMessage(chatId, '⚠️ Ошибка при обработке запроса. Попробуйте еще раз.');
    }
}
