'use strict';
// Local read-only analytics extracted from Regime. No trading, notifications, or cross-service calls.
const express = require('express');
const axios = require('axios');
const { httpAgent, httpsAgent } = require('./lib/httpAgents');
const { computeMACD, computeRSI } = require('./indicators/macdRsi');
const { enhance: enhanceRegime } = require('./regime/enhancedJudge');
const router = express.Router();
const BINANCE_FAPI = 'https://fapi.binance.com';
const SYMBOL = 'BTCUSDT', INTERVAL = '1h', INTERVAL_15M = '15m', LIMIT = 500, CHART_TAIL = 50;
const TIMEOUT = Number(process.env.BINANCE_TIMEOUT_MS || 10000);
const REFRESH_MS = 5 * 60 * 1000;
let cache = { updatedAt: 0, klines: [], indicators: null, regime: null, tradePlan: null, m15: null, error: null };
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
function wilderSmooth(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + values[i]) / period;
  }
  return out;
}

// ---------------------- 指标计算 ----------------------
/**
 * 计算 ATR(14)
 */
function computeATR(h, l, c, period = 14) {
  const tr = [0];
  for (let i = 1; i < c.length; i++) {
    tr.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  return wilderSmooth(tr, period);
}

/**
 * 计算 ADX / +DI / -DI (14)
 */
function computeADX(h, l, c, period = 14) {
  const len = c.length;
  const tr = [0], plusDM = [0], minusDM = [0];
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    ));
  }
  const atr = wilderSmooth(tr, period);
  const pDM = wilderSmooth(plusDM, period);
  const mDM = wilderSmooth(minusDM, period);

  const plusDI = atr.map((a, i) => a ? 100 * pDM[i] / a : null);
  const minusDI = atr.map((a, i) => a ? 100 * mDM[i] / a : null);
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || (p + m) === 0) return null;
    return 100 * Math.abs(p - m) / (p + m);
  });

  // ADX = Wilder 平滑 dx
  const validDX = dx.map(v => v == null ? 0 : v);
  const adx = wilderSmooth(validDX, period).map((v, i) => dx[i] == null ? null : v);

  return { adx, plusDI, minusDI };
}

/**
 * 历史波动率 HV (替代 VIX)
 * 标准：sqrt(252) * std(log return) * 100，窗口默认 24（1 天，1h K线）
 */
function computeHV(close, window = 24) {
  const logRet = [null];
  for (let i = 1; i < close.length; i++) {
    logRet.push(Math.log(close[i] / close[i - 1]));
  }
  const out = new Array(close.length).fill(null);
  for (let i = window; i < close.length; i++) {
    const slice = logRet.slice(i - window + 1, i + 1);
    const m = mean(slice);
    const variance = mean(slice.map(x => (x - m) ** 2));
    // 年化：1h K线，一年约 24*365 根
    out[i] = Math.sqrt(variance) * Math.sqrt(24 * 365) * 100;
  }
  return out;
}

/**
 * ROC(14) 价格变化率
 */
function computeROC(close, period = 14) {
  const out = new Array(close.length).fill(null);
  for (let i = period; i < close.length; i++) {
    out[i] = ((close[i] - close[i - period]) / close[i - period]) * 100;
  }
  return out;
}

/**
 * Slope 斜率（最近 N 根的最小二乘回归斜率，反映加速度）
 */
function computeSlope(close, window = 14) {
  const out = new Array(close.length).fill(null);
  for (let i = window - 1; i < close.length; i++) {
    const ys = close.slice(i - window + 1, i + 1);
    const n = ys.length;
    const xs = Array.from({ length: n }, (_, k) => k);
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) {
      num += (xs[k] - mx) * (ys[k] - my);
      den += (xs[k] - mx) ** 2;
    }
    out[i] = den === 0 ? 0 : num / den;
  }
  return out;
}

// ---------------------- Regime 判定 ----------------------
/**
 * 规则：
 *  - 趋势市：ADX > 25 且 HV 处于中高分位
 *  - 震荡市：ADX < 20 且 HV 处于中低分位
 *  - 恐慌市：HV 处于高位 且 ADX < 25（强波动但无方向）
 *  - 中性市：其余
 */
function judgeRegime(ind) {
  const lastIdx = ind.adx.length - 1;
  const adx = ind.adx[lastIdx];
  const plusDI = ind.plusDI[lastIdx];
  const minusDI = ind.minusDI[lastIdx];
  const hv = ind.hv[lastIdx];

  // 以最近 100 根 HV 的分位数判断高低波
  const hvSlice = ind.hv.slice(-100).filter(v => v != null).sort((a, b) => a - b);
  const q = p => hvSlice[Math.floor(hvSlice.length * p)] ?? hv;
  const hvHigh = q(0.7);
  const hvLow = q(0.3);

  let regime = 'NEUTRAL';
  let label = '中性市';
  let color = '#999';
  let desc = '市场无明显特征';

  if (hv >= hvHigh && adx < 25) {
    regime = 'PANIC'; label = '恐慌市'; color = '#e74c3c';
    desc = '高波动 + 弱趋势：注意风险，谨慎交易';
  } else if (adx > 25 && hv >= hvLow) {
    regime = 'TREND'; label = '趋势市'; color = '#27ae60';
    desc = `趋势强劲（${plusDI > minusDI ? '多头' : '空头'}），可顺势`;
  } else if (adx < 20 && hv <= hvHigh) {
    regime = 'RANGE'; label = '震荡市'; color = '#3498db';
    desc = '低波动 + 弱趋势：适合区间/网格策略';
  }

  return {
    regime, label, color, desc,
    metrics: {
      adx: +adx?.toFixed(2),
      plusDI: +plusDI?.toFixed(2),
      minusDI: +minusDI?.toFixed(2),
      hv: +hv?.toFixed(2),
      hvHigh: +hvHigh?.toFixed(2),
      hvLow: +hvLow?.toFixed(2),
    }
  };
}

// ---------------------- 交易计划生成 ----------------------
/**
 * 基于当前指标输出结构化交易计划（仅作建议，纯盯盘模式不会自动下单）。
 *
 * 方法：
 *   方向 — 由 regime + DI 决定
 *     · TREND  + +DI > -DI  → 做多（顺势）
 *     · TREND  + -DI > +DI  → 做空（顺势）
 *     · NEUTRAL 且 |+DI - -DI| > 8  → 小仓位试单
 *     · RANGE / PANIC / DI 模糊      → 观望
 *   入场 — 当前价回踩 0.5 × ATR（避免追高/杀跌，提高 R:R）
 *   止损 — 1.5 × ATR (Wilder 经典)
 *   止盈 — TP1 = 1R, TP2 = 2R, TP3 = 3R 分批离场（R = 风险距离）
 *   仓位 — ADX 越强、信号置信度越高，建议仓位越大（10% / 20% / 30%）
 */
function buildTradePlan(ind, regime, klines) {
  const close = klines.length ? klines[klines.length - 1].close : null;
  const lastIdx = klines.length - 1;
  const atr = ind.atr[lastIdx];
  const m = regime?.metrics || {};
  const adx = m.adx;
  const plusDI = m.plusDI;
  const minusDI = m.minusDI;

  // 数据完整性检查
  if (close == null || atr == null || atr <= 0 || adx == null) {
    return { ok: false, action: 'wait', reason: '指标数据不足，无法生成交易计划' };
  }

  // 方向 + 置信度 (直接使用 enhancedRegime 的分析结果，避免前后矛盾)
  const direction = regime.direction;
  const confidence = regime.confidence;
  const basis = regime.riskNote || `基于 ${regime.subLabel} 状态`;

  if (!direction || direction === 'neutral') {
    return {
      ok: false, action: 'wait',
      reason: regime.riskNote || '当前状态无明确方向，建议观望',
      currentPrice: close,
    };
  }

  // 入场点：回踩 0.5 ATR
  const entry = direction === 'long' ? close - 0.5 * atr : close + 0.5 * atr;
  // 止损：1.5 ATR
  const stop = direction === 'long' ? entry - 1.5 * atr : entry + 1.5 * atr;
  const risk = Math.abs(entry - stop); // = 1.5 * ATR
  // 止盈分级（R 倍数）
  const dirSign = direction === 'long' ? 1 : -1;
  const tp1 = entry + dirSign * 1 * risk;
  const tp2 = entry + dirSign * 2 * risk;
  const tp3 = entry + dirSign * 3 * risk;

  // 仓位建议: 一律按置信度小仓位 (高 3% / 中 2% / 低 1%), 不再用 50% 默认.
  //   100x 杠杆下 50% 仓位 = 必爆仓级别, 全局去掉; 自动/手动/热力图所有路径统一这套.
  const positionPct = ({ high: 3, medium: 2, low: 1 })[confidence] || 1;

  // 数值精度
  const round2 = (n) => Math.round(n * 100) / 100;
  const round3 = (n) => Math.round(n * 1000) / 1000;

  return {
    ok: true,
    action: direction === 'long' ? '做多 (LONG)' : '做空 (SHORT)',
    direction,
    confidence,
    confidenceLabel: { high: '高', medium: '中', low: '低' }[confidence],
    suggestedPositionPct: positionPct,

    currentPrice: round2(close),
    entry: round2(entry),
    stopLoss: round2(stop),
    riskPerUnit: round2(risk),
    riskPct: round3((risk / entry) * 100),

    takeProfits: [
      { level: 'TP1', price: round2(tp1), rr: '1R',
        closePct: 50, gainPct: round3(((dirSign * (tp1 - entry)) / entry) * 100),
        note: '平 50%；将止损上移到入场价（保本）' },
      { level: 'TP2', price: round2(tp2), rr: '2R',
        closePct: 30, gainPct: round3(((dirSign * (tp2 - entry)) / entry) * 100),
        note: '平 30%' },
      { level: 'TP3', price: round2(tp3), rr: '3R',
        closePct: 20, gainPct: round3(((dirSign * (tp3 - entry)) / entry) * 100),
        note: '平剩余 20%；趋势继续可改为移动止损 (1.5 ATR trailing)' },
    ],

    basis,
    notes: [
      `ATR(14) = ${atr.toFixed(2)}`,
      `ADX(14) = ${adx.toFixed(2)}（${confidence === 'high' ? '强' : confidence === 'medium' ? '中' : '弱'}趋势）`,
      `止损距离 = 1.5 × ATR = ${risk.toFixed(2)} (${(risk / entry * 100).toFixed(2)}%)`,
      `R:R = 1 : 3，期望盈亏比正向`,
      `仓位建议 ${positionPct}% 仓位（按账户资金计算）`,
      '只读指标参考；实际交易由本系统的 SmartDCA 引擎管理。',
    ],
  };
}

async function fetchKlines(interval = INTERVAL, limit = LIMIT) {
  const url = `${BINANCE_FAPI}/fapi/v1/klines`;
  const { data } = await axios.get(url, {
    params: { symbol: SYMBOL, interval, limit },
    timeout: TIMEOUT,
    httpAgent, httpsAgent,
  });
  return data.map(k => ({
    time: k[0],
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

/** 计算 15 分钟辅助指标（拉取失败时返回 null，不影响 1h 主流程） */
function compute15mIndicators(klines15) {
  if (!Array.isArray(klines15) || !klines15.length) return null;
  const c15 = klines15.map(k => k.close);
  const { macd, signal, hist } = computeMACD(c15, { fast: 12, slow: 26, signal: 9 });
  const rsi = computeRSI(c15, 14);
  return {
    rsi, macd, signal, hist,
    times: klines15.map(k => k.time),
    lastClose: c15[c15.length - 1],
    lastTime: klines15[klines15.length - 1].time,
  };
}

// 重入守卫: 防止上一轮 refresh 还没回(币安 fapi 慢响应), setInterval
// 5min 又触发新一轮 → klines/indicators 在堆里堆积 → GC 风暴 → CPU 100%.
// 这是排查时定位的 P1 元凶之一.
let _isRefreshing = false;
let _lastRefreshStartedAt = 0;

async function refresh() {
  if (_isRefreshing) {
    const ageSec = Math.round((Date.now() - _lastRefreshStartedAt) / 1000);
    console.warn(`[regime] 上一轮 refresh 还在跑 (${ageSec}s), 跳过本轮以防堆积`);
    return;
  }
  _isRefreshing = true;
  _lastRefreshStartedAt = Date.now();
  try {
    // 1h 主周期 + 15m 辅助周期并行拉取；15m 失败只降级（不影响 1h 主流程）
    const [klines, klines15] = await Promise.all([
      fetchKlines(INTERVAL, LIMIT),
      fetchKlines(INTERVAL_15M, LIMIT).catch(e => {
        console.error('[regime] 15m K线拉取失败(本轮跳过 15m 信号):', e.message);
        return null;
      }),
    ]);
    const h = klines.map(k => k.high);
    const l = klines.map(k => k.low);
    const c = klines.map(k => k.close);

    const atr = computeATR(h, l, c, 14);
    const { adx, plusDI, minusDI } = computeADX(h, l, c, 14);
    const hv = computeHV(c, 24);
    const roc = computeROC(c, 14);
    const slope = computeSlope(c, 14);

    // 新增：MACD(12,26,9) 与 RSI(14)
    const { macd, signal, hist } = computeMACD(c, { fast: 12, slow: 26, signal: 9 });
    const rsi = computeRSI(c, 14);

    const indicators = { atr, adx, plusDI, minusDI, hv, roc, slope, macd, signal, hist, rsi };
    const baseRegime = judgeRegime(indicators);

    // 增强 Regime：融合 MACD/RSI，产出细分状态 + 方向 + 置信度 + 风险提示
    const lastIdx = klines.length - 1;
    const enhanced = enhanceRegime(baseRegime, {
      adx: adx[lastIdx],
      plusDI: plusDI[lastIdx],
      minusDI: minusDI[lastIdx],
      hv: hv[lastIdx],
      macd: macd[lastIdx],
      signal: signal[lastIdx],
      hist: hist[lastIdx],
      rsi: rsi[lastIdx],
      close: c[lastIdx],
      histSeries: hist,
    });

    const tradePlan = buildTradePlan(indicators, enhanced, klines);

    // 15 分钟辅助指标（RSI / MACD）
    const m15 = compute15mIndicators(klines15);

    const prevRegime = cache.regime;
    cache = {
      updatedAt: Date.now(),
      klines,
      indicators,
      regime: enhanced,
      tradePlan,
      m15,
      error: null,
    };
    console.log(
      `[regime] refreshed @ ${new Date().toISOString()} -> ${enhanced.label}/${enhanced.subLabel} ` +
      `(dir=${enhanced.direction}, conf=${enhanced.confidenceLabel}) | plan: ${tradePlan.action}`
    );
  } catch (err) {
    cache.error = err.message;
    console.error('[regime] refresh failed:', err.message);
  } finally {
    _isRefreshing = false;
  }
}

router.get('/status', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    updatedAt: cache.updatedAt,
    regime: cache.regime,
    tradePlan: cache.tradePlan,
    // 15 分钟辅助指标最新值（拉取失败时为 null）
    m15: cache.m15 ? {
      rsi: cache.m15.rsi[cache.m15.rsi.length - 1],
      macdHist: cache.m15.hist[cache.m15.hist.length - 1],
      lastClose: cache.m15.lastClose,
      lastTime: cache.m15.lastTime,
    } : null,
  });
});

router.get('/data', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    updatedAt: cache.updatedAt,
    regime: cache.regime,
    klines: cache.klines,
    indicators: cache.indicators,
  });
});

// 前端面板专用接口：裁剪到最近 N 根, 字段名按图表习惯压缩
router.get('/snapshot', (req, res) => {
  if (!cache.indicators) {
    return res.status(503).json({ ok: false, error: cache.error || 'warming up' });
  }
  const tail = Math.min(parseInt(req.query.tail, 10) || 168, cache.klines.length);
  const start = cache.klines.length - tail;
  const slice = (a) => a.slice(start);
  const klines = slice(cache.klines);
  const ind = cache.indicators;
  const last = klines.length - 1;
  const lastFullIdx = cache.klines.length - 1;

  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    refreshMs: REFRESH_MS,
    updatedAt: cache.updatedAt,
    error: cache.error,
    regime: cache.regime,
    tradePlan: cache.tradePlan,
    latest: {
      time: klines[last]?.time,
      close: klines[last]?.close,
      atr: ind.atr[lastFullIdx],
      adx: ind.adx[lastFullIdx],
      plusDI: ind.plusDI[lastFullIdx],
      minusDI: ind.minusDI[lastFullIdx],
      hv: ind.hv[lastFullIdx],
      roc: ind.roc[lastFullIdx],
      slope: ind.slope[lastFullIdx],
      // 新增：MACD / RSI 最新值
      macd: ind.macd?.[lastFullIdx] ?? null,
      signal: ind.signal?.[lastFullIdx] ?? null,
      hist: ind.hist?.[lastFullIdx] ?? null,
      rsi: ind.rsi?.[lastFullIdx] ?? null,
    },
    candles: klines.map((k) => ({
      t: k.time, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume,
    })),
    series: {
      atr: slice(ind.atr),
      adx: slice(ind.adx),
      plusDI: slice(ind.plusDI),
      minusDI: slice(ind.minusDI),
      hv: slice(ind.hv),
      roc: slice(ind.roc),
      slope: slice(ind.slope),
      // 新增：完整切片，与 candles 对齐
      macd: slice(ind.macd || []),
      signal: slice(ind.signal || []),
      hist: slice(ind.hist || []),
      rsi: slice(ind.rsi || []),
    },
    // 需求 1.2 / 1.3：独立返回 MACD / RSI 最近 50 个周期的历史数据供图表单独渲染
    macdRsi: buildMacdRsiChartSlice(cache.klines, ind, CHART_TAIL),
    // 15 分钟 MACD / RSI 最近 50 根（15m 拉取失败时为 null）
    macdRsi15: buildM15ChartSlice(cache.m15, CHART_TAIL),
  });
});

/** 提取 15 分钟 MACD / RSI 最近 N 根（与 buildMacdRsiChartSlice 同结构） */
function buildM15ChartSlice(m15, tail = CHART_TAIL) {
  if (!m15 || !Array.isArray(m15.times) || !m15.times.length) return null;
  const n = Math.min(tail, m15.times.length);
  const start = m15.times.length - n;
  const tailArr = (arr) => (Array.isArray(arr) ? arr.slice(start) : []);
  return {
    tail: n,
    times: m15.times.slice(start),
    macd: tailArr(m15.macd),
    signal: tailArr(m15.signal),
    hist: tailArr(m15.hist),
    rsi: tailArr(m15.rsi),
  };
}

/**
 * 提取 MACD / RSI 最近 N 个周期，单独返回给前端（满足需求 1.2 / 1.3）
 */
function buildMacdRsiChartSlice(klines, ind, tail = CHART_TAIL) {
  const n = Math.min(tail, klines.length);
  const start = klines.length - n;
  const points = klines.slice(start).map(k => k.time);
  const tailArr = (arr) => (Array.isArray(arr) ? arr.slice(start) : []);
  return {
    tail: n,
    times: points,
    macd: tailArr(ind.macd),
    signal: tailArr(ind.signal),
    hist: tailArr(ind.hist),
    rsi: tailArr(ind.rsi),
  };
}

function getLatestPlan() {
  let latest = null;
  if (cache.indicators && cache.indicators.atr) {
    const lastIdx = cache.indicators.atr.length - 1;
    // hvRef: HV 近 120 根均值, 供 trading 侧「HV/ROC 增强止盈止损」计算相对波动率
    const hvValid = (cache.indicators.hv || []).filter((v) => v != null && Number.isFinite(v));
    const recentHv = hvValid.slice(-120);
    const hvRef = recentHv.length
      ? recentHv.reduce((s, v) => s + v, 0) / recentHv.length
      : null;
    latest = {
      atr: cache.indicators.atr[lastIdx],
      adx: cache.indicators.adx[lastIdx],
      hv: cache.indicators.hv ? cache.indicators.hv[lastIdx] : null,
      hvRef,
      roc: cache.indicators.roc ? cache.indicators.roc[lastIdx] : null,
    };
  }
  return {
    tradePlan: cache.tradePlan,
    regime: cache.regime,
    latest,
    updatedAt: cache.updatedAt,
  };
}


function start() { void refresh(); const timer = setInterval(refresh, REFRESH_MS); timer.unref(); return timer; }
module.exports = { router, start, refresh, getState: () => cache, getLatestPlan };
start();
