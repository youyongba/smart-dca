'use strict';
// Test-only boundary fixtures. This file is never imported by server.js.
const Module = require('module');
const fs = require('fs');
const { EventEmitter } = require('events');
const load = Module._load;
const realWs = require('ws');
const calls = [];
const now = () => Date.now();
function klines(interval = '1h', limit = 500, end = now()) {
  const ms = ({ '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000,
    '4h': 14400000, '1d': 86400000, '1w': 604800000 })[interval] || 3600000;
  const start = Math.floor(end / ms) * ms - (limit - 1) * ms;
  return Array.from({ length: limit }, (_, i) => {
    const price = 60000 + i * 4 + Math.sin(i / 6) * 30;
    return [start + i * ms, String(price), String(price + 50), String(price - 50),
      String(price + 8), '100', start + (i + 1) * ms - 1, '6000000', 100, '60', '3600000', '0'];
  });
}
const axios = require('axios');
axios.get = async (input, options = {}) => {
  const url = new URL(input);
  for (const [key, value] of Object.entries(options.params || {})) url.searchParams.set(key, value);
  calls.push({ method: 'GET', url: url.href });
  if (process.env.TEST_NETWORK_FAILURE === '1') throw new Error('test upstream unavailable');
  const p = url.pathname;
  let data;
  if (p.endsWith('/klines')) data = klines(url.searchParams.get('interval'), Number(url.searchParams.get('limit') || 500), Number(url.searchParams.get('endTime') || now()));
  else if (p.endsWith('/premiumIndex')) data = { symbol: 'BTCUSDT', markPrice: '62000', indexPrice: '61995', interestRate: '0.0001', lastFundingRate: '0.0001', time: now() };
  else if (p.endsWith('/fundingRate')) data = Array.from({ length: 60 }, (_, i) => ({ fundingTime: now() - (60 - i) * 28800000, fundingRate: '0.0001' }));
  else if (p.endsWith('/fundingInfo')) data = [];
  else if (p.endsWith('/openInterest')) data = { symbol: 'BTCUSDT', openInterest: '100000', time: now() };
  else if (p.endsWith('/tickers')) data = { retCode: 0, time: now(), result: { list: [
    { symbol: 'BTCUSDT', fundingRate: '0.0001', fundingIntervalHour: '8', singleOpenInterestValue: '3000000000' }] } };
  else if (p.endsWith('/funding-rate')) data = { code: '0', data: [
    { instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', fundingTime: now(), nextFundingTime: now() + 28800000, ts: now() - 90000 }] };
  else if (p.endsWith('/open-interest')) data = { code: '0', data: [{ instId: 'BTC-USDT-SWAP', oiUsd: '2000000000', ts: now() }] };
  else if (p.endsWith('/depth')) data = { lastUpdateId: 1, bids: [['61990', '2']], asks: [['62010', '2']] };
  else if (p.endsWith('/ticker/price')) data = { symbol: 'BTCUSDT', price: '62000' };
  else throw new Error('Unmocked GET blocked: ' + url.href);
  return { status: 200, data };
};
axios.post = async (url, body) => {
  calls.push({ method: 'POST', url, body });
  if (url === 'https://api.hyperliquid.xyz/info' && body?.type === 'metaAndAssetCtxs') {
    if (process.env.TEST_NETWORK_FAILURE === '1') throw new Error('test upstream unavailable');
    return { status: 200, data: [{ universe: [{ name: 'BTC' }] },
      [{ funding: '0.0000125', openInterest: '50000', markPx: '62000' }]] };
  }
  throw new Error('External POST blocked by test harness');
};
class MarketSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = realWs.OPEN;
    setImmediate(() => {
      if (this.closed) return;
      this.emit('open');
      this.emit('message', Buffer.from(JSON.stringify({ stream: 'btcusdt@aggTrade',
        data: { e: 'aggTrade', s: 'BTCUSDT', p: '62000', q: '0.001', m: false, T: now() } })), false);
    });
  }
  close() { if (!this.closed) { this.closed = true; this.readyState = realWs.CLOSED; this.emit('close'); } }
  terminate() { this.close(); }
  ping() {}
  pong() {}
  send() {}
}
Object.assign(MarketSocket, { OPEN: realWs.OPEN, CLOSED: realWs.CLOSED, CONNECTING: realWs.CONNECTING, Server: realWs.Server });
Module._load = function (request, ...args) {
  if (request === 'ws') return MarketSocket;
  return load.call(this, request, ...args);
};
if (process.env.TEST_AUDIT_FILE) {
  process.on('exit', () => fs.writeFileSync(process.env.TEST_AUDIT_FILE,
    JSON.stringify({ calls, modules: Object.keys(require.cache) })));
}
