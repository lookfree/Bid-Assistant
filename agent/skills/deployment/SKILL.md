---
name: deployment-ops
description: 部署/运维/联调本系统时使用——服务器 60.205.160.74、mbp 跳板、SSH 隧道跑集成测试与迁移、收钱吧回调反代、密钥管理、docs 同步 mbp、数据存储拓扑。跑 test-on-mbp、应用迁移、配 nginx、动生产数据前读。
---

# 部署与运维

## 主机

- **服务器 `60.205.160.74`**（Alibaba Cloud Linux / x86，PG + Redis + MinIO 同机）。root 免密经 mbp 跳板（凭据不写文件）。同机连库须 `export DATABASE_URL` 用 `127.0.0.1`、`REDIS_HOST=127.0.0.1`、`MINIO_ENDPOINT=http://127.0.0.1:9000`。
- **`mbp`**（MacBook Pro，SSH 别名，免密 key，`~/.ssh/config` 配好）：既是集成测试跑测机，也是到 server 的跳板。`~/.bun/bin/bun`。

## 数据与中间件拓扑

- PostgreSQL 库 `bidsaas`，三 schema：`public`（App 业务+积分账本，Drizzle）/ `langgraph`（检查点）/ `agent`（观测）。
- Redis 前缀 `bid:`（Cron 分布式锁 + 缓存）。MinIO bucket `bidsaas`（招标文件/导出产物）。

## 集成测试 & 迁移 —— 必经 mbp SSH 隧道

本机（新加坡 Mac Mini）走公司 VPN 连国内阿里云到 PG 会**间歇丢包**（TCP 通、CONNECT_TIMEOUT 随机超时）——不是代码问题。阿里云安全组按源 IP 白名单放行 5432/9000，且 mbp 出口 IP 会漂移。**所以统一经 mbp 建 SSH 隧道**（`15432→5432 / 16379→6379 / 19000→9000`）访问，不追着 IP 改安全组。

```bash
./test-on-mbp.sh                          # apps/api 全量集成测试（合并门禁）
./test-on-mbp.sh test/xxx.test.ts …       # 单/多文件
```

`test-on-mbp.sh` 会：rsync apps/api + env 到 `mbp:~/bidtest` → 确保隧道存活 → `bun install` → 经隧道 `bun test`（export 改写 DATABASE_URL 把 `60.205.160.74:5432` 换成 `127.0.0.1:15432`）。

**新迁移**同法经隧道应用：同步 apps/api → 建隧道 → `ssh mbp` 里 export 改写后的 DATABASE_URL → `bun run drizzle-kit migrate`。**别从本机直连远程 PG。** 迁移**手写**（drizzle snapshot 停在 ~0017，`db:generate` 会污染），手动 append `drizzle/meta/_journal.json`。

## 收钱吧支付（生产联调）

- C 扫 B：`/upay/v2/precreate` 返 `qr_code`；terminal 激活产生 terminal_sn，每日签到轮换 terminal_key（AES 存）。真实 1 分钱冒烟已过（付→query→refund 闭环）。
- **回调 nginx 反代未完成**：server 8080 被既有 nginx 占；`location /api/payment/`→`127.0.0.1:8787` 的 reload 曾被 ssh 断打断，notify 仍 404。**http+IP 的 notify_url 收钱吧收不收未确认**（可能要 https+域名）——冒烟靠轮询 query 已验，回调非硬前提。这块是 Phase 4 待办。
- ⚠️ 收钱吧提供的任何参数（vendor_sn/key、app_id、公钥、激活码）**勿发布到开源/公开平台**；只存 `.env.bidsaas.local`。

## 密钥与配置

- 密钥只在 `.env.bidsaas.local`（gitignored）；模板 `.env.bidsaas.example`（只有变量名）。`AccessKey*.csv` gitignored。GitHub repo `lookfree/Bid-Assistant` 可能公开，**绝不提交真实凭据**。
- billing 配置（`credit_cost.*`/`recharge_packs`/`referral_rules`/…）在 DB 表 `billing_configs`，运营后台 `PUT /admin-api/plans/configs/:key` 可视化改、即生效（`getConfig` 无缓存直查）。种子占位在 `src/config/billing-seed.ts`（★非真实定价，真实值待运营配）。
- 首个运营超管：`cd apps/api && bun run admin:bootstrap`（env `ADMIN_BOOTSTRAP_USERNAME/PASSWORD`；生产用占位口令会被拒）。

## 双子域部署（架构 §3.3 / §13）

C 端 app.（复用 apps/web）+ 运营后台 admin.（apps/admin），独立子域、独立身份；反代按子域路由到对应前端容器。admin-api 挂 `/admin-api`，与 C 端 `/api` 分组隔离。

## docs 同步 mbp

计划/文档本地编辑 → 镜像到 `mbp:/Users/Administrator/Documents/02-Work/anjikeji/Bid Assistant/`（GitHub main 是权威，mbp 是便利副本可滞后）：

```bash
rsync -aR docs README.md "mbp:/Users/Administrator/Documents/02-Work/anjikeji/Bid Assistant/"
```

**远端带空格的路径用普通双引号，别用反斜杠转义空格**（转义那次真跑会静默失败）。非删除同步会残留旧文件——确认是废弃再手动 `ssh mbp rm`。
