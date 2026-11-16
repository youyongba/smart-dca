'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const project = path.resolve(__dirname, '..');
const manifest = require('../system.json');

function isolated(t, dependencies = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-independent-'));
  fs.cpSync(project, dir, { recursive: true, filter: source => {
    const rel = path.relative(project, source);
    return !rel || (!rel.split(path.sep).includes('node_modules') &&
      !rel.startsWith('data' + path.sep) && !['.env', '.instance.lock', 'spotDcaData.json'].includes(rel));
  } });
  if (dependencies) fs.cpSync(path.join(project, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function env(extra = {}) {
  return { PATH: process.env.PATH, HOME: os.tmpdir(), NODE_PATH: path.join(project, 'node_modules'),
    PORT: '0', HOST: '127.0.0.1', WEBHOOK_ENABLED: '0', TELEGRAM_PUSH_ENABLED: '0',
    MONITOR_WEBHOOK_ENABLED: '0', REGIME_FEISHU_ENABLED: '0', LIVE_TRADING_ENABLED: '0', ...extra };
}
async function start(dir, extra = {}) {
  const child = spawn(process.execPath, ['--require', path.join(dir, 'tests/helpers/network.cjs'), path.join(dir, 'server.js')], {
    cwd: os.tmpdir(), env: env(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Startup timeout:\n' + log)); }, 15000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Startup exit ' + code + '\n' + log)); });
    child.stderr.on('data', data => { log += data; });
    child.stdout.on('data', data => {
      log += data;
      const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  return { child, url, log: () => log };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('项目移出原仓库后仍能独立启动，页面和核心接口完整', { timeout: 30000 }, async t => {
  const dir = isolated(t, true);
  const audit = path.join(dir, 'audit.json');
  const run = await start(dir, { NODE_PATH: '', TEST_AUDIT_FILE: audit });
  try {
    const health = await fetch(run.url + '/healthz').then(r => r.json());
    assert.equal(health.system, manifest.id);
    assert.equal(health.liveTrading, false);
    const page = await fetch(run.url + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    assert.equal((await fetch(run.url + '/' + manifest.page)).status, 200);
    const endpoints = {
      'funding-monitor': ['/api/status', '/api/funding/weighted', '/api/regime/snapshot?tail=1', '/api/regime/ai-analysis/config'],
      mtf: ['/api/mtf/status'],
      'smart-dca': ['/api/spot-dca/status'],
      'pro-order-flow': ['/api/auto-trade/orderflow/history?tf=4h', '/api/mtf_walls', '/api/proxy/klines?interval=1d', '/api/proxy/depth'],
      regime: ['/api/regime/snapshot?tail=1', '/api/regime/mtf-auto-open', '/api/auto-trade/status', '/api/regime/backtest/status'],
    };
    for (const endpoint of endpoints[manifest.id]) {
      const response = await fetch(run.url + endpoint);
      assert.equal(response.status, 200, endpoint + '\n' + run.log());
      const body = await response.json();
      if (endpoint === '/api/funding/weighted') assert.equal(body.fresh, true);
      if (endpoint === '/api/mtf/status') {
        assert.equal(body.ok, true);
        assert.equal(body.timeframes.length, 7);
      }
      if (endpoint.includes('/regime/snapshot')) assert.ok(body.latest.atr > 0);
      if (endpoint === '/api/spot-dca/status') {
        assert.ok(body.realIndicators.currentAtr > 0);
        assert.equal(body.state.isLongBotRunning, false);
      }
    }
    const missing = manifest.id === 'smart-dca' ? '/api/auto-trade/status' : '/api/spot-dca/status';
    assert.equal((await fetch(run.url + missing)).status, 404, 'Unrelated system route must not be exposed');
    if (manifest.trading) {
      const route = manifest.id === 'smart-dca' ? '/api/spot-dca/override' : '/api/auto-trade/manual-follow';
      assert.equal((await fetch(run.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
      if (manifest.id === 'regime') assert.equal((await fetch(run.url + '/api/auto-trade/market-order')).status, 503);
    }
    const duplicate = spawnSync(process.execPath, [path.join(dir, 'server.js')], { cwd: os.tmpdir(), env: env(), encoding: 'utf8' });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /Another process owns/);
  } finally { await stop(run.child); }
  const evidence = JSON.parse(fs.readFileSync(audit));
  assert.equal(evidence.calls.filter(c => c.method === 'POST' && !c.url.includes('hyperliquid.xyz/info')).length, 0);
  if (manifest.id !== 'regime') {
    assert.equal(evidence.modules.some(file => /trading\/(router|executor|riskEngine|config)\.js$/.test(file)), false);
  }
  assert.equal(evidence.modules.some(file => file.startsWith(project + path.sep)), false, 'No loading code or dependencies from original project');
  assert.equal(fs.existsSync(path.join(dir, '.instance.lock')), false);
});

test('预览模式可验证Token，但仍禁止全部业务写操作', { timeout: 30000 }, async t => {
  const dir = isolated(t);
  const run = await start(dir, { CONFIG_AUTH_TOKEN: 'isolated-admin-token' });
  try {
    for (const token of ['', 'wrong', 'isolated-admin-token']) {
      const res = await fetch(run.url + '/api/spot-dca/auth', {
        method: 'POST', headers: { 'X-Auth-Token': token }
      });
      assert.equal(res.status, token === 'isolated-admin-token' ? 200 : 401);
    }
    for (const endpoint of ['config', 'api-keys', 'toggle-bot', 'custom-tp', 'refresh-atr', 'override']) {
      const res = await fetch(run.url + '/api/spot-dca/' + endpoint, {
        method: 'POST', headers: { 'X-Auth-Token': 'isolated-admin-token' }
      });
      assert.equal(res.status, 503, endpoint);
    }
  } finally { await stop(run.child); }
});

test('上游断网仍可访问页面，接口明确呈现未就绪或失败', { timeout: 30000 }, async t => {
  const dir = isolated(t);
  const run = await start(dir, { TEST_NETWORK_FAILURE: '1' });
  try {
    assert.equal((await fetch(run.url + '/')).status, 200);
    if (manifest.id === 'funding-monitor') {
      const state = await fetch(run.url + '/api/funding/weighted').then(r => r.json());
      assert.equal(state.fresh, false);
      assert.equal(state.history1h.length, 0);
    }
    if (manifest.id === 'mtf') assert.equal((await fetch(run.url + '/api/mtf/status').then(r => r.json())).ok, false);
    if (manifest.id === 'regime') assert.equal((await fetch(run.url + '/api/regime/snapshot')).status, 503);
    if (manifest.id === 'pro-order-flow') assert.equal((await fetch(run.url + '/api/proxy/depth')).status, 502);
  } finally { await stop(run.child); }
});

test('数据路径不能越过独立项目边界', t => {
  const dir = isolated(t);
  const result = spawnSync(process.execPath, [path.join(dir, 'server.js')], {
    env: env({ AUTO_TRADE_STATE_PATH: '../other-project/state.json' }), encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Data path must stay inside/);
});

test('迁移先预览，显式停机确认后复制，保留原文件并拒绝覆盖', t => {
  const dir = isolated(t);
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-migration-source-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const rel = manifest.data[0];
  if (!rel) return;
  const oldFile = path.join(source, rel);
  const newFile = path.join(dir, rel);
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  const value = rel === 'spotDcaData.json' ? { config: {}, positions: { long: { totalCoinAmount: 0.04, tp1Fired: true, lastDcaTime: 123 },
    short: {} }, signalMemory: { lastRsi: 25 } } : { preserved: 'original' };
  const content = JSON.stringify(value);
  fs.writeFileSync(oldFile, content);
  const migrate = extra => spawnSync(process.execPath,
    [path.join(dir, 'scripts/migrate-state.js'), '--from', source, ...extra], { env: env(), encoding: 'utf8' });
  assert.equal(migrate([]).status, 0);
  assert.equal(fs.existsSync(newFile), false);
  assert.notEqual(migrate(['--apply']).status, 0);
  assert.equal(migrate(['--apply', '--source-stopped']).status, 0);
  assert.equal(fs.readFileSync(newFile, 'utf8'), content);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), content);
  assert.notEqual(migrate(['--apply', '--source-stopped']).status, 0);
});

test('交易项目未确认旧系统停用时不能实盘启动', t => {
  if (!manifest.trading) return;
  const dir = isolated(t);
  const result = spawnSync(process.execPath, [path.join(dir, 'server.js')], {
    env: env({ LIVE_TRADING_ENABLED: '1', CONFIG_AUTH_TOKEN: 'test' }), encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /old trading owner is stopped/);
});
