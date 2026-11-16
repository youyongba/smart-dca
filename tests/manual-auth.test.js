'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine, createUI } = require('../scripts/test_spot_dca_config');
const TOKEN = 'isolated-admin-token';
const event = { preventDefault() {} };
const response = (status, body) => ({ status, ok: status === 200, json: async () => body });

test('所有手动入口在无Token时拦截，取消不发送写请求或弹出交易确认', async () => {
    const actions = [
        ui => ui.openConfig(), ui => ui.saveConfig(),
        ui => ui.openApiSettings(), ui => ui.saveApiSettings(),
        ui => ui.toggleBot('long'), ui => ui.toggleBot('short'),
        ui => ui.executeQuickTrade('market-buy'), ui => ui.executeQuickTrade('market-buy-short'),
        ui => ui.openOverrideModal(), ui => ui.refreshStaticAtr(),
        ...['long', 'short'].flatMap(side => [1, 2, 3].map(level => ui => ui.editTpPrice(level, 100, side))),
        ...['market-buy', 'market-buy-short', 'market-sell-long', 'market-sell-short'].map(action => ui => {
            ui.switchOverrideTab(action, { className: '' });
            return ui.executeOverride();
        })
    ];
    for (const action of actions) {
        const ui = await createUI(undefined, { token: '' });
        const pending = action(ui);
        assert.equal(ui.elements.get('auth-modal').classList.contains('hidden'), false);
        assert.equal(ui.requests.some(req => req.options.method === 'POST'), false);
        ui.closeAuthToken();
        await pending;
        assert.equal(ui.requests.some(req => req.options.method === 'POST'), false);
        assert.equal(ui.confirmations.length, 0);
        assert.equal(ui.prompts.length, 0);
    }
});

test('首次验证成功后存储Token并继续原操作，刷新后有Token不再弹窗', async () => {
    const ui = await createUI(undefined, { token: '' });
    assert.equal(ui.elements.get('auth-modal').classList.contains('hidden'), true);
    const pending = ui.openConfig();
    ui.elements.get('input-auth-token').value = ` ${TOKEN} `;
    await ui.submitAuthToken(event);
    await pending;
    assert.equal(ui.storage.get('CONFIG_AUTH_TOKEN'), TOKEN);
    assert.equal(ui.elements.get('config-modal').classList.contains('hidden'), false);
    assert.equal(ui.elements.get('input-auth-token').value, '');
    await ui.openApiSettings();
    assert.equal(ui.elements.get('api-modal').classList.contains('hidden'), false);
    assert.equal(ui.requests.filter(req => req.url.endsWith('/auth')).length, 1);
    const reloaded = await createUI(undefined, { token: ui.storage.get('CONFIG_AUTH_TOKEN') });
    await reloaded.openConfig();
    assert.equal(reloaded.elements.get('auth-modal').classList.contains('hidden'), true);
    assert.equal(reloaded.requests.some(req => req.url.endsWith('/auth')), false);
});

test('空Token和错误Token不存储、不放行，错误后可继续输入', async () => {
    const ui = await createUI(undefined, { token: '' });
    const pending = ui.openApiSettings();
    await ui.submitAuthToken(event);
    assert.match(ui.elements.get('auth-error').textContent, /请输入/);
    ui.elements.get('input-auth-token').value = 'wrong';
    await ui.submitAuthToken(event);
    assert.match(ui.elements.get('auth-error').textContent, /不正确/);
    assert.equal(ui.storage.has('CONFIG_AUTH_TOKEN'), false);
    assert.equal(ui.elements.get('api-modal').classList.contains('hidden'), true);
    ui.elements.get('input-auth-token').value = TOKEN;
    await ui.submitAuthToken(event);
    await pending;
    assert.equal(ui.elements.get('api-modal').classList.contains('hidden'), false);
});

test('缓存Token随所有手动写请求发送，包含双向开平仓和TP1至TP3', async () => {
    const ui = await createUI();
    ui.setConfirm(true);
    ui.setPrompt('123');
    ui.setFetch(async () => response(200, {
        ok: true, config: ui.engine.getConfig(), state: ui.engine.getState()
    }));
    await ui.toggleBot('long');
    await ui.toggleBot('short');
    for (const side of ['long', 'short']) {
        for (const level of [1, 2, 3]) await ui.editTpPrice(level, 100, side);
    }
    await ui.refreshStaticAtr();
    await ui.executeQuickTrade('market-buy');
    await ui.executeQuickTrade('market-buy-short');
    for (const action of ['market-buy', 'market-buy-short', 'market-sell-long', 'market-sell-short']) {
        ui.switchOverrideTab(action, { className: '' });
        await ui.executeOverride();
    }
    ui.elements.get('input-api-key').value = 'isolated-key';
    ui.elements.get('input-api-secret').value = 'isolated-secret';
    await ui.saveApiSettings();
    await ui.openConfig();
    await ui.saveConfig();
    const writes = ui.requests.filter(req => req.options.method === 'POST');
    assert.equal(writes.length, 17);
    for (const req of writes) assert.equal(req.options.headers['X-Auth-Token'], TOKEN, req.url);
    assert.equal(ui.elements.get('auth-modal').classList.contains('hidden'), true);
});

test('401清除Token但不自动重发交易，503和网络错误保留缓存', async () => {
    const ui = await createUI();
    ui.setFetch(async () => response(503, { ok: false, error: '实盘未开启' }));
    await assert.rejects(ui.authFetch('/api/spot-dca/override', { method: 'POST' }), /实盘未开启/);
    assert.equal(ui.storage.get('CONFIG_AUTH_TOKEN'), TOKEN);
    ui.setFetch(async () => { throw new Error('网络断开'); });
    await assert.rejects(ui.authFetch('/api/spot-dca/override', { method: 'POST' }), /网络断开/);
    assert.equal(ui.storage.get('CONFIG_AUTH_TOKEN'), TOKEN);
    ui.setFetch(async () => response(401, { ok: false }));
    const before = ui.requests.length;
    await assert.rejects(ui.authFetch('/api/spot-dca/override', { method: 'POST' }), /已失效/);
    assert.equal(ui.requests.length, before + 1);
    assert.equal(ui.storage.has('CONFIG_AUTH_TOKEN'), false);
    const pending = ui.openConfig();
    assert.equal(ui.elements.get('auth-modal').classList.contains('hidden'), false);
    ui.closeAuthToken();
    await pending;
});

test('授权等待期间重复点击不排队执行，取消后的迟到响应不能保存Token', async () => {
    const ui = await createUI(undefined, { token: '' });
    const first = ui.ensureAuthToken();
    assert.equal(await ui.ensureAuthToken(), null);
    let release;
    ui.setFetch(() => new Promise(resolve => { release = resolve; }));
    ui.elements.get('input-auth-token').value = TOKEN;
    const submit = ui.submitAuthToken(event);
    ui.closeAuthToken();
    assert.equal(await first, null);
    release(response(200, { ok: true }));
    await submit;
    assert.equal(ui.storage.has('CONFIG_AUTH_TOKEN'), false);
});

test('后端所有手动接口必须通过鉴权，缺失配置时拒绝放行', () => {
    const engine = createEngine();
    const expected = ['/auth', '/api-keys', '/toggle-bot', '/custom-tp', '/config', '/refresh-atr', '/override'];
    assert.deepEqual([...engine.routeHandlers.keys()], expected);
    for (const route of expected) {
        const admin = engine.routeHandlers.get(route).find(fn => fn.name === 'requireAdmin');
        assert.ok(admin, route);
        for (const token of [undefined, '', 'wrong', TOKEN]) {
            let passed = false;
            const res = { code: 200, status(code) { this.code = code; return this; }, json() {} };
            admin({ headers: { 'x-auth-token': token } }, res, () => { passed = true; });
            assert.equal(passed, token === TOKEN, route);
            assert.equal(res.code, token === TOKEN ? 200 : 401);
        }
    }
    const unconfigured = createEngine({ authToken: '' });
    const admin = unconfigured.routeHandlers.get('/auth')[0];
    const res = { status(code) { assert.equal(code, 503); return this; }, json() {} };
    admin({ headers: { 'x-auth-token': TOKEN } }, res, () => assert.fail('不得放行'));
    const auth = engine.routeHandlers.get('/auth').at(-1);
    auth({}, { json(body) { assert.equal(body.ok, true); } });
    assert.equal(engine.persisted(), undefined);
});
