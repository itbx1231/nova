const axios = require('axios');
const db = require('../database');

// Telegram Bot credentials (should be added to .env, using fallback for demo)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE';

async function sendTelegramAlert(message) {
  if (TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.log('[ALERT] Telegram token not configured. Message:', message);
    return;
  }
  
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: `🚨 *Nova Infrastructure Alert*\n\n${message}`,
      parse_mode: 'Markdown'
    });
    console.log('[ALERT] Telegram alert sent successfully.');
  } catch (error) {
    console.error('[ALERT] Failed to send Telegram alert:', error.message);
  }
}

async function checkThresholds() {
  try {
    // Get latest system metrics from the history table (populated by existing disk-monitor/index.js)
    const { rows } = await db.pool.query('SELECT * FROM history ORDER BY timestamp DESC LIMIT 1');
    if (!rows.length) return;

    const latest = rows[0];
    const alerts = [];

    // Thresholds
    if (latest.cpu > 90) alerts.push(`🔥 High CPU Usage: ${latest.cpu.toFixed(1)}%`);
    
    // RAM is stored differently, but assuming standard representation
    if (latest.mem > 95) alerts.push(`🧠 High Memory Usage: ${latest.mem.toFixed(1)}%`);

    // We can also check disk if stored, assuming it is.

    if (alerts.length > 0) {
      const message = alerts.join('\n');
      await sendTelegramAlert(message);
    }
  } catch (err) {
    console.error('[ALERT] Error checking thresholds:', err.message);
  }
}

// Run every 5 minutes
setInterval(checkThresholds, 5 * 60 * 1000);

module.exports = { sendTelegramAlert, checkThresholds };
