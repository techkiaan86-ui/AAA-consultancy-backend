const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_URL = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : '';

/**
 * Sends a Telegram Message to a chat (user or group).
 * Fallbacks to mock logging if Bot Token is not configured.
 */
exports.sendTelegramMessage = async (chatId, text) => {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log(`[Telegram Service Stub] (Simulating Telegram message to chat ${chatId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Telegram Service] Error sending message:', err.response?.data || err.message);
    throw err;
  }
};
