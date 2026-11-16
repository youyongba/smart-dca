'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
let releaseLock;

function insideRoot(file) {
  const resolved = path.resolve(ROOT, file);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error('Data path must stay inside this independent project: ' + file);
  }
  let parent = resolved;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error('External data symlink rejected');
  return resolved;
}

function acquireLock() {
  const file = path.join(ROOT, '.instance.lock');
  const token = crypto.randomUUID();
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { throw new Error('Invalid instance lock; inspect .instance.lock before removing it'); }
    try { process.kill(owner.pid, 0); }
    catch (e) {
      if (e.code === 'ESRCH') {
        fs.unlinkSync(file);
        return acquireLock();
      }
      throw e;
    }
    throw new Error('Another process owns this project: PID ' + owner.pid);
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
  fs.closeSync(fd);
  releaseLock = () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
    } catch (_) {}
  };
  process.once('exit', releaseLock);
}

function hasExposure(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.active === true || value.pending === true || value.status === 'active' || value.status === 'pending' ||
      value.pendingOrder || value.isLongBotRunning || value.isShortBotRunning ||
      value.enabledLong || value.enabledShort || value.pureLong || value.pureShort ||
      Number(value.totalCoinAmount) > 0 ||
      (Array.isArray(value.items) && value.items.length > 0)) return true;
  return Object.values(value).some(v => v && typeof v === 'object' && hasExposure(v));
}

function init() {
  if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') {
    throw new Error('Only one Fork process per project is supported');
  }
  process.chdir(ROOT);
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const manifest = require('../system.json');
  for (const key of ['AUTO_TRADE_CONFIG_PATH', 'AUTO_TRADE_STATE_PATH', 'MTF5_AUTO_OPEN_STATE_PATH',
    'REGIME_NOTIFY_STATE_PATH', 'FUNDING_NOTIFY_STATE_PATH', 'BACKTEST_HISTORY_PATH', 'BACKTEST_LAST_RESULT_PATH']) {
    if (process.env[key]) process.env[key] = insideRoot(process.env[key]);
  }
  insideRoot('data');
  insideRoot('spotDcaData.json');
  const live = process.env.LIVE_TRADING_ENABLED === '1';
  if (manifest.trading) {
    if (!live) {
      for (const rel of manifest.data) {
        const file = insideRoot(rel);
        if (!fs.existsSync(file)) continue;
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (hasExposure(saved) || (manifest.id === 'smart-dca' && (saved.config?.apiKey || saved.config?.apiSecret))) {
          throw new Error('Existing trading state requires LIVE_TRADING_ENABLED=1 and a completed migration');
        }
      }
      for (const key of ['AUTO_TRADE_STATE_PATH', 'MTF5_AUTO_OPEN_STATE_PATH']) {
        if (!process.env[key] || !fs.existsSync(process.env[key])) continue;
        if (hasExposure(JSON.parse(fs.readFileSync(process.env[key], 'utf8')))) {
          throw new Error('Configured trading state requires LIVE_TRADING_ENABLED=1');
        }
      }
      if (manifest.id === 'smart-dca' && (process.env.BINANCE_API_KEY || process.env.BINANCE_SPOT_API_KEY)) {
        throw new Error('Binance credentials require explicit LIVE_TRADING_ENABLED=1');
      }
    } else {
      if (!process.env.CONFIG_AUTH_TOKEN) throw new Error('Live trading requires CONFIG_AUTH_TOKEN');
      if (process.env.LEGACY_TRADING_STOPPED !== '1') {
        throw new Error('Confirm the old trading owner is stopped with LEGACY_TRADING_STOPPED=1');
      }
      if (manifest.id === 'regime') {
        const file = insideRoot(process.env.AUTO_TRADE_CONFIG_PATH || 'data/auto_trade_config.json');
        const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        const url = process.env.AUTO_TRADE_WEBHOOK_URL || saved.webhookUrl;
        const token = process.env.AUTO_TRADE_WEBHOOK_TOKEN || saved.token;
        if (!url || !token || !/^https?:\/\//.test(url)) throw new Error('Live Regime requires a configured execution webhook and token');
      }
    }
  }
  acquireLock();
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const port = Number(process.env.PORT || manifest.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  return { root: ROOT, port, host: process.env.HOST || '127.0.0.1', live, manifest };
}

function requireLive(req, res, next) {
  if (process.env.LIVE_TRADING_ENABLED !== '1') {
    return res.status(503).json({ ok: false, error: '独立项目默认关闭实盘。完成迁移后设置 LIVE_TRADING_ENABLED=1 并重启。' });
  }
  next();
}

function serve(app, runtime, upgrades) {
  app.get('/healthz', (req, res) => res.json({ ok: true, system: runtime.manifest.id, liveTrading: runtime.live }));
  app.get('/api/system', (req, res) => res.json({ id: runtime.manifest.id, name: runtime.manifest.name, liveTrading: runtime.live }));
  const server = app.listen(runtime.port, runtime.host, () => {
    console.log(runtime.manifest.name + ': http://' + runtime.host + ':' + server.address().port);
  });
  server.on('error', error => { console.error(error.message); process.exit(1); });
  server.on('upgrade', (req, socket, head) => {
    if (!upgrades || !upgrades(req, socket, head)) socket.destroy();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  }
  return server;
}
module.exports = { init, serve, requireLive, insideRoot, hasExposure };
