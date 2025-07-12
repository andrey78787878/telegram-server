app.post('/webhook', async (req, res) => {
  const body = req.body;

  try {
    // === 1. Обработка нажатий на кнопки (callback_query)
    if (body.callback_query) {
      console.log('➡️ Получен callback_query:', body.callback_query);

      const dataRaw = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const messageId = body.callback_query.message.message_id;
      const username = '@' + (body.callback_query.from.username || body.callback_query.from.first_name);

      // --- Если кнопка: выбор исполнителя
      if (dataRaw.startsWith('select_executor:')) {
        const parts = dataRaw.split(':');
        const row = parts[1];
        const executor = parts[2];

        if (!row || !executor) {
          console.warn("⚠️ Неверный формат select_executor:", dataRaw);
          return res.sendStatus(200);
        }

        console.log(`👤 Выбран исполнитель ${executor} для заявки #${row}`);

        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'markInProgress',
            row,
            executor
          }
        });

        const originalText = body.callback_query.message.text;
        const cleanedText = originalText
          .replace(/🟢 Заявка #\d+ в работе\.\n👤 Исполнитель: @\S+/g, '')
          .replace(/✅ Заявка #\d+ закрыта\..*/gs, '')
          .replace(/🟢 В работе\n👤 Исполнитель:.*(\n)?/g, '')
          .trim();

        const updatedText = `${cleanedText}\n\n🟢 В работе\n👤 Исполнитель: ${executor}`;

        await editMessageText(
          chatId,
          messageId,
          updatedText,
          buildFollowUpButtons(row)
        );

        await sendMessage(chatId, `📌 Заявка №${row} принята в работу исполнителем ${executor}`, {
          reply_to_message_id: messageId
        });

        return res.sendStatus(200);
      }

      // --- Все остальные кнопки (выполнено, отмена, задержка)
      let data;
      try {
        data = JSON.parse(dataRaw);
      } catch (e) {
        console.warn("⚠️ Невалидный JSON в callback_data:", dataRaw);
        return res.sendStatus(200);
      }

      const { action, row, messageId: originalMessageId } = data;

      if (action === 'in_progress' && row) {
        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'markInProgress',
            row,
            executor: username
          }
        });

        const originalText = body.callback_query.message.text;
        const cleanedText = originalText
          .replace(/🟢 Заявка #\d+ в работе\.\n👤 Исполнитель: @\S+/g, '')
          .replace(/✅ Заявка #\d+ закрыта\..*/gs, '')
          .replace(/🟢 В работе\n👤 Исполнитель:.*(\n)?/g, '')
          .trim();

        const updatedText = `${cleanedText}\n\n🟢 В работе\n👤 Исполнитель: ${username}`;

        await editMessageText(
          chatId,
          messageId,
          updatedText,
          buildFollowUpButtons(row)
        );

        return res.sendStatus(200);
      }

      if (action === 'completed' && row) {
        userStates[chatId] = { stage: 'awaiting_photo', row, messageId, username };
        console.log(`📸 Ожидается фото от ${username} для заявки #${row}`);
        await askForPhoto(chatId);
        return res.sendStatus(200);
      }

      if ((action === 'delayed' || action === 'cancelled') && row) {
        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action,
            row,
            executor: username
          }
        });

        const updatedText = `${body.callback_query.message.text}\n\n📌 Статус: ${action === 'delayed' ? 'Ожидает поставки' : 'Отменена'}\n👤 Исполнитель: ${username}`;

        await editMessageText(
          chatId,
          messageId,
          updatedText
        );

        return res.sendStatus(200);
      }
    }

    // === 2. Обработка обычных сообщений (фото, сумма, комментарий)
    else if (body.message) {
      console.log('✉️ Получено сообщение:', body.message);

      const chatId = body.message.chat.id;
      const state = userStates[chatId];
      if (!state) return res.sendStatus(200);

      // --- Фото
      if (state.stage === 'awaiting_photo' && body.message.photo) {
        const fileId = body.message.photo.at(-1).file_id;

        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const filePath = fileRes.data.result.file_path;
        const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;

        state.photo = fileUrl;
        state.stage = 'awaiting_sum';

        console.log(`📥 Фото получено. URL: ${fileUrl}`);
        await askForSum(chatId);
        return res.sendStatus(200);
      }

      // --- Сумма
      if (state.stage === 'awaiting_sum' && body.message.text) {
        const sum = body.message.text.trim();
        if (!/^d+$/.test(sum)) {
          await sendMessage(chatId, "❗ Введите сумму только цифрами.");
          return res.sendStatus(200);
        }

        state.sum = sum;
        state.stage = 'awaiting_comment';

        console.log(`💰 Сумма получена: ${sum}`);
        await askForComment(chatId);
        return res.sendStatus(200);
      }

      // --- Комментарий
      if (state.stage === 'awaiting_comment' && body.message.text) {
        const comment = body.message.text.trim();
        const { row, photo, sum, username, messageId } = state;

        console.log('📤 Отправка в GAS:', {
          action: 'updateAfterCompletion',
          row,
          photoUrl: photo,
          sum,
          comment,
          executor: username,
          message_id: messageId
        });

        await axios.post(GAS_WEB_APP_URL, {
          data: {
            action: 'updateAfterCompletion',
            row,
            photoUrl: photo,
            sum,
            comment,
            executor: username,
            message_id: messageId
          }
        });

        const originalText = state.originalText || body.message.reply_to_message?.text || '';
        const cleanedText = originalText
          .replace(/\n?🟢 В работе.*?(\n👤 Исполнитель:.*)?/, '')
          .replace(/\n?📎 Фото: .*$/m, '')
          .replace(/\n?💰 Сумма: .*$/m, '')
          .replace(/\n?👤 Исполнитель: .*$/m, '')
          .replace(/\n?✅ Статус: .*$/m, '')
          .replace(/\n?✅ Заявка закрыта\..*$/m, '');

        const updatedText = `${cleanedText}
📎 Фото: <a href="${photo}">ссылка</a>
💰 Сумма: ${sum} сум
👤 Исполнитель: ${username}
✅ Статус: Выполнено
💬 Комментарий: ${comment}`.trim();

        await editMessageText(chatId, messageId, updatedText, { inline_keyboard: [] });
        await sendMessage(chatId, `📌 Заявка №${row} закрыта.`, { reply_to_message_id: messageId });

        delete userStates[chatId];
        return res.sendStatus(200);
      }
    }

    console.log('⚠️ Ничего не обработано явно. Возврат 200 OK');
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Ошибка в webhook:", err);
    return res.sendStatus(500);
  }
});
