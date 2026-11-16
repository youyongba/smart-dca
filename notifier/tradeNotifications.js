'use strict';

const feishu = require('./feishuWebhook');
const telegram = require('./telegram');
const { cnTime } = require('../lib/timeFmt');

const sent = new Set();
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value) : null;
const fmt = (value, digits = 8) => {
    const n = number(value);
    return n === null ? '未提供' : n.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};

function buildTradeMessage({ pending, order, fill, position, config, isLong, recovered = false }) {
    if (!pending?.clientOrderId || !['entry', 'close'].includes(pending.kind) ||
        !['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(order?.status) ||
        !(fill?.qty > 0) || !(fill?.quote > 0)) {
        throw new Error('交易通知缺少已确认成交数据');
    }
    const before = pending.before || {};
    const market = pending.market || config.tradeMode;
    const isEntry = pending.kind === 'entry';
    const manual = pending.label === 'manual';
    const oldQty = number(before.totalCoinAmount);
    const action = isEntry
        ? (oldQty === null ? '开仓/加仓' : oldQty > 0 ? '加仓' : '开仓')
        : /^TP[123]$/.test(pending.label) ? `${pending.label} 止盈`
            : pending.label === '保本止损' ? '保本止损' : '平仓';
    const price = fill.quote / fill.qty;
    const oldAverage = number(before.averagePrice);
    const pnl = !isEntry && oldAverage > 0 ? (price - oldAverage) * fill.qty * (isLong ? 1 : -1) : null;
    const fees = new Map();
    const feeRows = Array.isArray(order.fills) ? order.fills : [];
    const hasFees = feeRows.length > 0 && feeRows.every(row =>
        row.commissionAsset && number(row.commission) !== null);
    if (hasFees) {
        for (const row of feeRows) {
            fees.set(row.commissionAsset, (fees.get(row.commissionAsset) || 0) + Number(row.commission));
        }
    }
    const feeText = hasFees
        ? [...fees].map(([asset, fee]) => `${fmt(fee)} ${asset}`).join(' + ')
        : '订单回执未提供，请以交易所成交账单为准';
    const status = order.status === 'FILLED' ? '已完全成交' : `部分成交，订单已终止 (${order.status})`;
    const exchangeTime = Number(order.updateTime || order.transactTime || order.time) || 0;
    const requested = pending.requestedQty ?? order.origQty;
    const tp = [1, 2, 3].map(level =>
        `TP${level}: ${position[`tp${level}Fired`] ? '已完成' : '未完成'}`).join(' | ');
    const lines = [
        `SmartDCA | ${manual ? '手动' : '自动'}${action} | ${isLong ? '多头' : '空头'}`,
        `交易对: BTCUSDT | 市场: ${market === 'futures' ? 'U本位永续合约' : '现货'} | 市价单`,
        `状态: ${status}${recovered ? ' | 原订单核对恢复' : ''}`,
        `方向: ${isEntry ? (isLong ? 'BUY 开多' : 'SELL 开空') : (isLong ? 'SELL 平多' : 'BUY 平空')}`,
        `成交数量: ${fmt(fill.qty)} BTC`,
        `成交均价: ${fmt(price)} USDT`,
        `成交金额${market === 'futures' ? '(名义价值，非保证金)' : ''}: ${fmt(fill.quote)} USDT`,
        `委托数量: ${fmt(requested)} BTC`,
        ...(pending.requestedQuote ? [`委托金额: ${fmt(pending.requestedQuote)} USDT`] : []),
        ...(market === 'futures' ? [`策略杠杆: ${fmt(pending.leverage ?? config.leverage)}x (非交易所实时核验)`] : []),
        `手续费: ${feeText}`,
        ...(!isEntry ? [`本次平仓估算毛盈亏: ${fmt(pnl)} USDT (未扣手续费及资金费)`] : []),
        `交易前仓位: ${fmt(oldQty)} BTC | 均价: ${fmt(oldAverage)} USDT`,
        `交易后仓位: ${fmt(position.totalCoinAmount)} BTC | 均价: ${fmt(position.averagePrice)} USDT`,
        `剩余仓位成本: ${fmt(position.totalUsdtAmount)} USDT`,
        `当前累计建仓次数: ${fmt(position.activeDcaCount, 0)} (含首仓)`,
        tp,
        `保本保护: ${position.slMoved ? '已激活' : '未激活'}`,
        `交易所订单号: ${order.orderId ?? pending.orderId ?? '未提供'}`,
        `客户端订单号: ${pending.clientOrderId}`,
        `交易所时间: ${exchangeTime ? cnTime(exchangeTime) : '未提供'} (UTC+8)`,
        `确认时间: ${cnTime()} (UTC+8)`
    ];
    return {
        key: `${market}:${pending.clientOrderId}:${order.status}:${fill.qty}`,
        text: lines.join('\n')
    };
}

function notifyTrade(details) {
    const message = buildTradeMessage(details);
    if (sent.has(message.key)) return Promise.resolve([]);
    sent.add(message.key);
    if (sent.size > 2000) sent.delete(sent.values().next().value);
    const deliver = async (channel, send) => {
        try {
            const result = await send();
            if (!result?.ok) console.error(`[TradeNotify] ${channel}: ${result?.skipped || result?.error || 'delivery_failed'}; ${message.key}`);
            return result;
        } catch (_) {
            console.error(`[TradeNotify] ${channel}: delivery_failed; ${message.key}`);
            return { ok: false, error: 'delivery_failed' };
        }
    };
    return Promise.all([
        // Every trade matters, including multiple TP fills in the same price tick.
        deliver('Feishu', () => feishu.sendText(message.text, { force: true, eventKey: 'trade' })),
        deliver('Telegram', () => telegram.sendText(message.text))
    ]);
}

module.exports = { buildTradeMessage, notifyTrade };
