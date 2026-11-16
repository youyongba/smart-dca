'use strict';

const axios = require('axios');
const { httpAgent, httpsAgent } = require('../lib/httpAgents');

const CFG = {
    enabled: process.env.TELEGRAM_PUSH_ENABLED !== '0',
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: (process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_VIP_GROUP_ID || '').trim()
};
let queue = Promise.resolve();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function postText(text) {
    if (!CFG.enabled) return { ok: false, skipped: 'telegram_disabled' };
    if (!CFG.token || !CFG.chatId) return { ok: false, skipped: 'telegram_not_configured' };
    for (let attempt = 0; attempt < 3; attempt++) {
        let code;
        let retryAfter = 0;
        try {
            const res = await axios.post(`https://api.telegram.org/bot${CFG.token}/sendMessage`, {
                chat_id: CFG.chatId, text, disable_web_page_preview: true
            }, { httpAgent, httpsAgent, timeout: 10000 });
            if (res.data?.ok === true) return { ok: true };
            code = res.data?.error_code || 'invalid_response';
            retryAfter = Number(res.data?.parameters?.retry_after) || 0;
        } catch (error) {
            // Never log Axios errors here: their URL contains the bot token.
            code = error.response?.data?.error_code || error.response?.status || 'network_error';
            retryAfter = Number(error.response?.data?.parameters?.retry_after) || 0;
        }
        if (attempt === 2 || (Number(code) >= 400 && Number(code) < 500 && Number(code) !== 429)) {
            return { ok: false, error: `Telegram delivery failed (${code})` };
        }
        await sleep(Math.min(60000, Math.max(800 * (attempt + 1), retryAfter * 1000)));
    }
}

function sendText(text) {
    // Independent queue: a Feishu outage must not delay Telegram.
    const delivery = queue.then(() => postText(String(text)));
    queue = delivery.catch(() => {});
    return delivery;
}

module.exports = { sendText };
