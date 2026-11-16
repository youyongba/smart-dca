'use strict';

// Build a replacement from the pre-submit snapshot, so retrying recovery cannot add a fill twice.
function recoverPosition(target, order, config, isLong, fill, atr = 0, now = Date.now()) {
    const pending = target.pendingOrder;
    if (!pending || order.clientOrderId !== pending.clientOrderId || order.symbol !== 'BTCUSDT') {
        throw new Error('核对响应与原订单不匹配');
    }
    const market = pending.market || config.tradeMode;
    if (market !== config.tradeMode) throw new Error('订单市场与当前配置不一致');
    if (!['entry', 'close'].includes(pending.kind)) throw new Error('未知订单类型，需人工核对');
    const expectedSide = pending.kind === 'entry' ? (isLong ? 'BUY' : 'SELL') : (isLong ? 'SELL' : 'BUY');
    if (order.side !== expectedSide ||
        (market === 'futures' && order.positionSide !== (isLong ? 'LONG' : 'SHORT')) ||
        (market === 'spot' && !isLong)) {
        throw new Error('订单方向与本地记录不匹配');
    }
    const next = { ...(pending.before || target) };
    delete next.pendingOrder;
    const oldQty = Number(next.totalCoinAmount);
    const oldQuote = Number(next.totalUsdtAmount);
    if (!Number.isFinite(oldQty) || oldQty < 0 || !Number.isFinite(oldQuote) || oldQuote < 0) {
        throw new Error('原仓位账务无效，需人工核对');
    }
    if (pending.kind === 'entry') {
        next.totalCoinAmount = oldQty + fill.qty;
        next.totalUsdtAmount = oldQuote + fill.quote;
        next.averagePrice = next.totalUsdtAmount / next.totalCoinAmount;
        next.activeDcaCount = (Number(next.activeDcaCount) || 0) + 1;
        if (oldQty < 0.00001) {
            next.entryTime = Number(order.updateTime || order.time) || pending.createdAt || now;
            next.totalFees = 0;
        }
        next.lastDcaTime = now;
        next.retryAfter = 0;
        if (Number.isFinite(atr) && atr > 0) next.lockedAtr = atr;
        next.tp1Fired = next.tp2Fired = next.tp3Fired = next.slMoved = false;
        next.customTp1Price = next.customTp2Price = next.customTp3Price = null;
    } else {
        if (fill.qty > oldQty + 1e-8 || oldQty <= 0 ||
            (pending.requestedQty && fill.qty > Number(pending.requestedQty) + 1e-8)) {
            throw new Error('平仓成交数量与原仓位不一致，需人工核对');
        }
        next.totalCoinAmount = Math.max(0, oldQty - fill.qty);
        next.totalUsdtAmount = oldQuote * (next.totalCoinAmount / oldQty);
        if (next.totalCoinAmount < 0.00001) {
            next.totalCoinAmount = next.totalUsdtAmount = next.averagePrice = next.activeDcaCount = next.totalFees = 0;
            next.entryTime = null;
        }
        if (['TP1', 'TP2', 'TP3'].includes(pending.label) && order.status === 'FILLED') {
            next[`${pending.label.toLowerCase()}Fired`] = true;
        }
        next.slMoved = next.totalCoinAmount > 0 && next.tp1Fired && config.breakevenSl;
        if (pending.label === 'manual' && next.totalCoinAmount === 0) {
            next.tp1Fired = next.tp2Fired = next.tp3Fired = next.slMoved = false;
            next.customTp1Price = next.customTp2Price = next.customTp3Price = null;
            next.lockedAtr = 0;
        }
        next.retryAfter = now + (order.status === 'FILLED' ? 0 : 60000);
    }
    if (market === 'futures') {
        next.positionSync = {
            confirmedAt: now, orderUpdateTime: Number(order.updateTime || order.time) || 0,
            expectedQty: next.totalCoinAmount
        };
    }
    return next;
}

// Allow the just-confirmed fill to reach positionRisk before reconciling a discrepancy.
// Missing updateTime (including an empty position response) needs two stable later snapshots.
function waitForPositionSnapshot(target, remote, now = Date.now()) {
    const sync = target.positionSync;
    if (!sync) return false;
    const qty = Math.abs(Number(remote?.positionAmt || 0));
    const samePrice = qty === 0 || Math.abs(Number(remote?.entryPrice) - target.averagePrice) <= Math.max(1e-8, target.averagePrice * 1e-8);
    if (Math.abs(qty - Number(sync.expectedQty)) <= 1e-8 && samePrice) {
        delete target.positionSync;
        return false;
    }
    if (now - sync.confirmedAt < 15000) return true;
    const signature = `${qty}:${remote?.entryPrice || 0}`;
    if (sync.candidate !== signature) {
        sync.candidate = signature;
        sync.candidateAt = now;
        return true;
    }
    if (now - sync.candidateAt < 5000) return true;
    if (remote?.updateTime && sync.orderUpdateTime && remote.updateTime < sync.orderUpdateTime) return true;
    delete target.positionSync;
    return false;
}

module.exports = { recoverPosition, waitForPositionSnapshot };
