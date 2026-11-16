# SpotDCA 订单恢复与快照同步

本模块仅计算仓位恢复结果，不提交订单、不调用交易所、不直接写存档。

## 订单恢复

`recoverPosition(target, order, config, isLong, fill, atr, now)`：

- `target.pendingOrder` 保存原 `clientOrderId`、市场、开平仓类型和提交前 `before` 仓位。
- `order` 必须与原订单、BTCUSDT、LONG/SHORT 和买卖方向匹配。
- `fill` 由 `spotAutoBot.confirmedFill` 从实际成交量与成交金额或 `avgPrice` 计算，不能用请求数量代替。
- 默认仅接受 `FILLED`；后台恢复可接受已撤销或过期订单的非零累计成交。仍在撮合的 `PARTIALLY_FILLED` 不解锁。
- 使用 `before` 重建账务，重复恢复不会叠加同一笔成交。
- 手动平仓按实际成交量扣减。剩余仓位保留 TP、静态 ATR 和自定义目标；不能因为不是全平就永久卡住，也不能把尾仓直接清零。
- 未完整成交的 TP1 不标记为完成，不提前开启保本止损。

引擎负责持有提交锁、清理信号记忆并立即原子保存。`completeOrder` 若保存失败，会保留原订单意图用于再次核对。

## 交易所订单号

提交回执中的 `orderId`、订单状态及更新时间写入 `pendingOrder`。查询优先使用已保存的交易所订单号，否则使用原 `origClientOrderId`；两种方式均核验返回的客户订单号和币种，不补发订单。

缺少密钥时在创建订单意图之前拒绝操作。查询失败原因写入 `pendingOrder.lastError`，页面以纯文本显示，即使暂时没有仓位卡片也能看到。

## 持仓快照

`waitForPositionSnapshot(target, remote, now)` 返回是否继续等待，不修改实际仓位数量。

合约成交后保存 `positionSync`。新成交的数量、均价与交易所一致时立即结束等待；不一致时：

1. 前 15 秒不使用不一致快照覆盖已确认成交。
2. 之后至少取得两次间隔 5 秒、数量和均价相同的快照。
3. 若交易所提供更新时间，早于订单更新时间的快照仍不接受。

存在待核对订单或快照等待标记时，每 5 秒独立补拉持仓。查询不占下单锁，慢余额接口不延长手动下单锁；请求期间发生新成交时，丢弃该请求结果，包括页面快照。

## 运维

- 不删除 `pendingOrder` 或 `spotDcaData.json` 来解除暂停，否则可能重复下单或丢失 TP 状态。
- 部署后由操作人员重启实际运行的 SpotDCA 进程，不同时启动原版和独立版。
- 密钥权限、时间戳、网络、账户持仓模式等交易所错误需要根据页面具体原因处理。未取得可信订单结果时继续暂停是保护行为。
- 回归命令：`node --test scripts/test_spot_dca.js scripts/test_spot_dca_config.js`。
