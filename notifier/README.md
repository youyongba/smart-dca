# 交易通知

## 触发范围

手动现货买入/卖出、合约开多/开空/平多/平空、自动首仓、自动加仓、TP1/TP2/TP3 和保本止损。每笔真实成交在仓位成功保存后，分别发送到飞书和 Telegram，不需要浏览器在线或 `CONFIG_AUTH_TOKEN`。

原订单核对恢复的成交也发送通知，终止订单的部分成交会明确标注。NEW、未终止的 PARTIALLY_FILLED、提交超时、被拒绝及零成交订单不会发送“成交成功”消息，等待原订单查询确认。这里不发送独立的挂单或失败告警。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| FEISHU_WEBHOOK_URL | 飞书自定义群机器人地址 |
| FEISHU_WEBHOOK_SECRET | 飞书签名密钥，启用签名校验时必填 |
| WEBHOOK_ENABLED | `0` 关闭飞书；非 `0` 开启。与原 MTF 飞书通知共用 |
| TELEGRAM_BOT_TOKEN | Telegram Bot Token |
| TELEGRAM_VIP_GROUP_ID | Telegram 目标群 ID，兼容现有配置 |
| TELEGRAM_CHAT_ID | 可选；设置时优先于 TELEGRAM_VIP_GROUP_ID |
| TELEGRAM_PUSH_ENABLED | `0` 关闭 TG；未设置时，有完整凭证即发送 |

示例配置文件默认关闭通知，正式使用需开启对应开关。Telegram 机器人必须已加入目标群并具备发消息权限。凭证只在服务端读取，不放入消息内容。改动环境变量后由操作人员手动重启服务。

## 消息字段

包括操作来源、开仓/加仓/平仓或止盈级别、多空方向、市场、成交状态、实际成交数量/均价/名义金额、委托数量或金额、策略杠杆、手续费、交易前后仓位与均价、剩余成本、累计建仓次数、TP1-TP3 进度、保本保护状态、交易所订单号、客户端订单号以及交易所/确认时间。

时间固定为 UTC+8，不随韩国服务器时区变化。成交金额不是合约保证金；策略杠杆不是交易所实时杠杆查询结果。平仓毛盈亏按原持仓均价与实际成交计算，未扣手续费和资金费，不能当作净收益。手续费仅使用成交回执 `fills` 中实际返回的数值，保留币种；合约或查询回执未提供时标记“未提供”，不伪造为零。历史待确认订单缺少原仓位快照时，也不编造仓位或盈亏。

## 模块接口

`tradeNotifications.js` 提供：

- `buildTradeMessage(details)`：生成 `{ key, text }`，不发送网络请求。
- `notifyTrade(details)`：发送双通道通知，返回各通道结果的 Promise。相同成交在进程内去重。

`details` 参数：

| 字段 | 内容 |
| --- | --- |
| pending | 原订单意图，含 clientOrderId、kind、label、market、before，以及可选委托数量/金额、策略杠杆 |
| order | 已核验的交易所订单回执 |
| fill | `confirmedFill()` 得到的实际 `{ qty, quote }` |
| position | 成交入账后的仓位 |
| config | 当前策略配置，消息只取市场和杠杆，不输出密钥 |
| isLong | 多头为 true，空头为 false |
| recovered | 原订单查询恢复时为 true |

交易调用端统一使用 `spotAutoBot.reportConfirmedTrade()` 隔离同步异常和异步失败。正常订单由 `completeOrder(target, tradeDetails)` 在保存成功后调用；恢复订单在 `saveData()` 成功后调用。不要在提交订单前调用，也不要等待通知网络请求后才释放交易锁。

```js
completeOrder(target, {
    order,
    fill: confirmedFill(order),
    config,
    isLong: true
});
```

## 发送与验证

飞书沿用原签名和重试机制，交易消息使用 `force: true` 绕过全局间隔及同类冷却，因此同一行情连续 TP1-TP3 不被冷却过滤。TG 使用独立串行队列、10 秒超时、最多 3 次尝试，并处理 429 的 retry_after；权限类错误不重试。不设置 parse_mode，避免消息内容被误解析为 Markdown/HTML。

网络失败不会回滚已成交仓位或重新下单。失败在服务端以 `[TradeNotify]` 记录。通知使用内存队列，进程突然退出、持续网络失败或飞书队列溢出仍可能丢失通知，不提供跨重启可靠投递保证。网络重试也可能造成平台侧重复消息，请用客户端订单号核对，交易所成交账单始终是最终依据。

隔离测试不会向真实群组发送消息：

```bash
node --test tests/trade-notifications.test.js scripts/test_spot_dca.js
```
