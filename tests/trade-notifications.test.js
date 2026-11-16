'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function load(name, dependencies, env = {}) {
    const logs = [];
    const delays = [];
    const sandbox = {
        module: { exports: {} }, process: { env },
        console: { log() {}, error: (...args) => logs.push(args.join(' ')), warn() {} },
        setTimeout(fn, delay) { delays.push(delay); fn(); },
        require: key => {
            if (Object.hasOwn(dependencies, key)) return dependencies[key];
            if (key === '../lib/timeFmt') return require('../lib/timeFmt');
            if (key === 'crypto') return require('node:crypto');
            throw new Error(`Unexpected dependency: ${key}`);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'notifier', name), 'utf8'), sandbox);
    return { ...sandbox.module.exports, logs, delays };
}

function details(overrides = {}) {
    return {
        pending: { clientOrderId: 'unit-order', orderId: '123', market: 'futures',
            kind: 'close', label: 'TP1', requestedQty: 0.005, leverage: 10,
            before: { totalCoinAmount: 0.01, averagePrice: 60000 } },
        order: { orderId: '123', status: 'FILLED', updateTime: 1700000000000 },
        fill: { qty: 0.005, quote: 305 },
        position: { totalCoinAmount: 0.005, totalUsdtAmount: 300, averagePrice: 60000,
            activeDcaCount: 2, tp1Fired: true, tp2Fired: false, tp3Fired: false, slMoved: true },
        config: { tradeMode: 'futures', leverage: 100, apiKey: 'must-not-leak-key', apiSecret: 'must-not-leak-secret' },
        isLong: true, ...overrides
    };
}

function notifier(feishuSend = async () => ({ ok: true }), tgSend = async () => ({ ok: true })) {
    return load('tradeNotifications.js', {
        './feishuWebhook': { sendText: feishuSend },
        './telegram': { sendText: tgSend }
    });
}

test('完整消息包含成交、仓位、TP进度、订单号与固定东八区时间，不包含密钥', () => {
    const n = notifier();
    const { text } = n.buildTradeMessage(details());
    for (const value of ['自动TP1 止盈', '多头', '成交数量: 0.005 BTC', '成交均价: 61000 USDT',
        '305 USDT', '策略杠杆: 10x', '估算毛盈亏: 5 USDT', '交易前仓位: 0.01 BTC',
        '交易后仓位: 0.005 BTC', 'TP1: 已完成', 'TP2: 未完成', 'TP3: 未完成',
        '保本保护: 已激活', '订单号: 123', '客户端订单号: unit-order', '06:13:20', 'UTC+8']) {
        assert.ok(text.includes(value), value);
    }
    assert.match(text, /手续费: 订单回执未提供/);
    assert.doesNotMatch(text, /must-not-leak/);
    const short = n.buildTradeMessage(details({ isLong: false, fill: { qty: 0.005, quote: 295 } })).text;
    assert.match(short, /BUY 平空/);
    assert.match(short, /估算毛盈亏: 5 USDT/);
});

test('手动开仓与自动加仓区分，现货手续费按币种保留精度', () => {
    const n = notifier();
    const d = details();
    d.pending = { ...d.pending, kind: 'entry', label: 'manual', market: 'spot',
        before: { totalCoinAmount: 0, averagePrice: 0 } };
    d.order.fills = [
        { commission: '0.00000123', commissionAsset: 'BNB' },
        { commission: '0.00000001', commissionAsset: 'BNB' },
        { commission: '0.0023', commissionAsset: 'USDT' }
    ];
    const text = n.buildTradeMessage(d).text;
    assert.match(text, /手动开仓/);
    assert.match(text, /手续费: 0.00000124 BNB \+ 0.0023 USDT/);
    assert.doesNotMatch(text, /策略杠杆|毛盈亏/);
    d.pending.label = '买入(做多)';
    d.pending.before.totalCoinAmount = 0.01;
    assert.match(n.buildTradeMessage(d).text, /自动加仓/);
});

test('部分成交恢复不能写成完全成交，未知委托前仓位不伪造成零', () => {
    const n = notifier();
    const d = details({ recovered: true });
    d.order.status = 'EXPIRED';
    delete d.pending.before;
    const text = n.buildTradeMessage(d).text;
    assert.match(text, /部分成交，订单已终止/);
    assert.match(text, /原订单核对恢复/);
    assert.match(text, /交易前仓位: 未提供/);
    assert.match(text, /毛盈亏: 未提供/);
    assert.doesNotMatch(text, /已完全成交/);
    for (const status of ['NEW', 'PARTIALLY_FILLED', 'REJECTED']) {
        assert.throws(() => n.buildTradeMessage(details({ order: { status } })));
    }
    assert.throws(() => n.buildTradeMessage(details({ fill: { qty: 0, quote: 0 } })));
});

test('同一订单去重，连续TP1至TP3分别双通道发送且强制绕过消息冷却', async () => {
    const feishu = [];
    const telegram = [];
    const n = notifier(async (text, options) => { feishu.push({ text, options }); return { ok: true }; },
        async text => { telegram.push(text); return { ok: true }; });
    for (const level of [1, 2, 3]) {
        const d = details();
        d.pending.label = `TP${level}`;
        d.pending.clientOrderId = `unit-tp${level}`;
        await n.notifyTrade(d);
        await n.notifyTrade(d);
    }
    assert.equal(feishu.length, 3);
    assert.equal(telegram.length, 3);
    for (let i = 0; i < 3; i++) {
        assert.equal(feishu[i].text, telegram[i]);
        assert.equal(feishu[i].options.force, true);
    }
});

test('飞书挂起不阻塞TG，通道异常不输出含凭证的错误对象', async () => {
    let release;
    let tgSent = false;
    const n = notifier(() => new Promise(resolve => { release = resolve; }), async () => {
        tgSent = true;
        throw new Error('secret-token-in-request-url');
    });
    const pending = n.notifyTrade(details());
    assert.equal(tgSent, true);
    release({ ok: false, error: 'network_error' });
    const result = await pending;
    assert.equal(result[0].ok, false);
    assert.equal(result[1].ok, false);
    assert.doesNotMatch(n.logs.join('\n'), /secret-token/);
});

test('TG使用已有VIP群配置，纯文本发送并支持429重试', async () => {
    const requests = [];
    const n = load('telegram.js', {
        '../lib/httpAgents': {},
        axios: { post: async (url, body, options) => {
            requests.push({ url, body, options });
            return requests.length === 1
                ? { data: { ok: false, error_code: 429, parameters: { retry_after: 2 } } }
                : { data: { ok: true } };
        } }
    }, { TELEGRAM_BOT_TOKEN: 'unit-token', TELEGRAM_VIP_GROUP_ID: '-100123' });
    assert.equal((await n.sendText('SmartDCA <成交>')).ok, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.telegram.org/botunit-token/sendMessage');
    assert.equal(requests[0].body.chat_id, '-100123');
    assert.equal(requests[0].body.text, 'SmartDCA <成交>');
    assert.equal(requests[0].body.parse_mode, undefined);
    assert.equal(requests[0].options.timeout, 10000);
    assert.equal(n.delays[0], 2000);
});

test('TG关闭或缺少配置不请求网络，权限错误不重试且不泄露Token', async () => {
    let calls = 0;
    const deps = { '../lib/httpAgents': {}, axios: { post: async () => {
        calls++;
        throw Object.assign(new Error('https://api.telegram.org/botsecret/sendMessage'), {
            response: { status: 403 }
        });
    } } };
    for (const env of [{}, { TELEGRAM_PUSH_ENABLED: '0', TELEGRAM_BOT_TOKEN: 'unit', TELEGRAM_CHAT_ID: 'unit' }]) {
        assert.equal((await load('telegram.js', deps, env).sendText('trade')).ok, false);
    }
    assert.equal(calls, 0);
    const result = await load('telegram.js', deps, {
        TELEGRAM_BOT_TOKEN: 'unit', TELEGRAM_CHAT_ID: 'unit'
    }).sendText('trade');
    assert.equal(calls, 1);
    assert.match(result.error, /403/);
    assert.doesNotMatch(result.error, /secret/);
});

test('飞书交易消息连续发送不丢TP事件，并按现有密钥签名', async () => {
    const requests = [];
    const n = load('feishuWebhook.js', {
        '../lib/httpAgents': {},
        axios: { post: async (url, body) => { requests.push({ url, body }); return { data: { code: 0 } }; } }
    }, { FEISHU_WEBHOOK_URL: 'https://example.invalid/test', FEISHU_WEBHOOK_SECRET: 'unit-secret' });
    for (const label of ['TP1', 'TP2', 'TP3']) {
        assert.equal((await n.sendText(label, { force: true, eventKey: 'trade' })).ok, true);
    }
    assert.equal(requests.length, 3);
    const first = requests[0].body;
    assert.equal(first.sign, require('node:crypto').createHmac('sha256', `${first.timestamp}\nunit-secret`).update('').digest('base64'));
});
