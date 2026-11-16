# SpotDCA / SmartDCA

保留现货/合约 SmartDCA、开平仓、分批止盈、动态保本、信号顺序、仓位持久化和未确认订单恢复。本地 MTF/Regime 仅提供指标，绝不启动 Regime 的 trading 引擎。

此目录为完整项目，可独立复制到其它服务器。`lib/` 等代码是本项目自己的文件，不依赖上级目录、共享服务或其它四个项目。

## 启动

推荐 Node.js 24 LTS，最低 20。在本目录运行：

```bash
npm ci
cp .env.example .env
npm test
npm start
```

默认地址 `http://127.0.0.1:3103/`；原页面路径 `/SpotDCA.html` 仍可访问。
默认不带凭证、不复制原 `.env`、不自动迁移存档。代理仅通过终端环境变量设置，不写入代码或 `.env`。

## 配置

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| HOST | 127.0.0.1 | 监听地址，公网使用反向代理 |
| PORT | 3103 | 本项目端口 |
| CONFIG_AUTH_TOKEN | 空 | 管理接口令牌，不能使用公开示例值 |
| BINANCE_TIMEOUT_MS | 10000 | 行情请求超时 |
| LIVE_TRADING_ENABLED | 0 | 完成迁移后才允许设为1 |
| LEGACY_TRADING_STOPPED | 0 | 操作人员确认旧交易管理进程已停止 |

其它业务变量见 `.env.example` 和各模块源代码，原字段拼写保持不变。通知凭证为空时不发送通知；外部 AI 功能仍需要配置的服务可用。

## 交易通知

手动开平仓、自动首仓/加仓、TP1-TP3、保本止损及原订单成交恢复，在成交确认并保存仓位后异步推送飞书与 Telegram。包含实际成交量价、名义金额、订单号、手续费可用信息、估算平仓毛盈亏、剩余仓位与止盈进度。通知失败不会阻塞交易，也不受浏览器 Token 授权影响。

飞书使用 `FEISHU_WEBHOOK_URL`、`FEISHU_WEBHOOK_SECRET`，需开启 `WEBHOOK_ENABLED=1`（与 MTF 通知共用）。TG 使用 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_VIP_GROUP_ID`，可用 `TELEGRAM_PUSH_ENABLED=0` 单独关闭。示例配置默认关闭通知；已有凭证的部署在未设置 TG 开关时默认发送。具体字段、调用方式及投递限制见 [notifier/README.md](notifier/README.md)。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /healthz | 进程存活，不代表交易所数据就绪 |
| GET | /api/system | 系统身份及是否启用实盘 |
| GET | /api/spot-dca/status | 配置、仓位及行情状态 |
| POST | /api/spot-dca/auth | 验证系统 Token，无请求体，无交易副作用 |
| POST | /api/spot-dca/config | 策略配置 |
| POST | /api/spot-dca/api-keys | 设置交易凭证 |
| POST | /api/spot-dca/toggle-bot | 自动开仓开关 |
| POST | /api/spot-dca/custom-tp | 自定义止盈 |
| POST | /api/spot-dca/refresh-atr | 更新ATR |
| POST | /api/spot-dca/override | 手动交易操作 |
| WS | /api/ws-dca | 持仓和指标推送 |

原业务接口的请求结构、字段名、鉴权方式保持不变。上游未就绪时返回原有 `ok:false` 或 503；行情错误不伪造为有效数据。

### 手动操作授权

策略配置、接口鉴权设置、一键做多/做空、启动/停止双向引擎、修改 TP1-TP3、重新计算止盈和市价开平仓均要求系统 Token。首次操作弹出密码输入框，通过 `/api/spot-dca/auth` 校验后，以 `CONFIG_AUTH_TOKEN` 为键保存在当前站点的 `localStorage`，后续操作及刷新页面自动复用，并通过 `X-Auth-Token` 请求头提交。只浏览状态不会弹出授权框。

验证接口成功返回 `200 {"ok":true}`；错误或缺失 Token 返回 401，服务端未配置 Token 返回 503。只有 401 会清除已缓存的 Token；网络故障和 503 不清除。授权取消不执行操作，鉴权失败不自动重发交易，重新点击操作后可再次输入。预览模式允许验证 Token，但原有实盘写操作限制不变。

Token 仅在当前浏览器、当前站点共享；清除站点数据、更换浏览器或域名后需要重新输入。请仅在可信设备上使用，并通过 HTTPS 部署；同源脚本可以读取 `localStorage`。更换服务端 Token 后需手动重启服务生效。

## 实盘启用与迁移

默认 `LIVE_TRADING_ENABLED=0`，写入交易接口返回明确的 503，不会假报成交。存在真实持仓、挂单、武装开关或 SmartDCA 存档密钥时，默认预览启动会被拒绝。

先备份并核对原持仓、未确认订单和TP状态；停止原交易进程与目标进程后，再迁移存档。新旧项目不能同时管理同一仓位。项目锁只保护本目录，无法自动检测其它机器的进程。

实盘需要配置 `CONFIG_AUTH_TOKEN`，设置 `LIVE_TRADING_ENABLED=1` 与 `LEGACY_TRADING_STOPPED=1` 并重启。配置自己的币安 API 凭证或恢复原存档中的凭证。保留原账户模式，不要删除或手改持仓状态。

## 数据

所属存档：

- `spotDcaData.json`


在首次启动前预览迁移，工具不导入 `.env`、不覆盖已有目标文件：

```bash
node scripts/migrate-state.js --from /absolute/old-project
# 仅在源、目标均已停止写入后：
node scripts/migrate-state.js --from /absolute/old-project --apply --source-stopped
```

工具原样复制并校验SHA-256，保留源文件。发现目标已有文件、目标正在运行、非法JSON或路径越界时拒绝执行。旧自定义路径需先整理停机快照到 `system.json` 列出的标准路径。新配置的数据路径不得越出本项目。

## 部署

```bash
pm2 start ecosystem.config.cjs
pm2 restart smart-dca
```

只允许单个Fork实例，禁止Cluster。PM2的cwd固定为当前项目目录。不要让nodemon监视状态文件，也不要在实盘使用开发热重载。
`nginx.conf.example` 提供本系统专用域名反向代理模板，需配置域名与TLS。服务和代理由操作人员手动启动。

## 验证

`npm test` 在临时目录中运行，不接触本目录或旧系统的真实交易状态。涵盖独立运行、接口、断网降级、路径隔离、进程锁与迁移防覆盖，并包含原SmartDCA交易回归。
生产入口不加载测试网络替身。实盘端到端成交与云主机网络仍需部署后核对，不能用离线测试代替。

### 2026-11-15 订单恢复修复

手动平仓按实际成交量结算，保留未平尾仓；已撤销或过期但有部分成交的原订单可恢复，不补发订单。成交后快速同步持仓，旧快照不能立即覆盖新成交。查询错误会在页面展示具体原因，不能通过删除 `pendingOrder` 解锁。

本次验证：61 项交易/配置回归及 5 项独立性测试通过。未调用真实账户下单、未改动仓位存档、未自动重启服务。
