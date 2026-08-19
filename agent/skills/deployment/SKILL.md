---
name: deployment-ops
description: 部署/运维/联调本系统时使用——唯一发版目标 230 客户环境（经 mbp 跳板，deploy-cust.sh），数据面 231 + HK 开发库（WG 10.66.66.1），域名 www.zhiqiyuan.cn，密钥管理、迁移、回滚、集成测试直连。发版、应用迁移、配 nginx、动生产数据前读。
---

# 部署与运维（2026-08-19 重写；60.205.160.74 旧环境已到期作废）

## 唯一发版目标 = 230 客户环境

**2026-07-30 起只发 230**，不存在第二套要同步的环境。拓扑：

- **230 = 应用机 `192.168.106.230`（用户 `angeek`）**：api / agent-api / agent-worker / web / admin / nginx 六容器。
- **231 = 数据机 `192.168.106.231`**：客户的 PG / Redis / MinIO / OCR。**绝不重启这三个数据容器**（客户活数据，重启全站停）。
- 只经 **mbp 跳板**可达：`ssh mbp` → `ssh angeek@192.168.106.230`（scp 同理两跳；本地直连 230 不通）。
- 公网入口 **`https://www.zhiqiyuan.cn`**（WoTrus 证书至 2027-03-04；`:80` 按 Host 分流不一律跳转——内网直连 `192.168.106.230` 原样服务，hairpin NAT 不通）。运营后台 `:8081/18081` 仍 http。
- 230 部署目录 `~/bid/app`（**非 git 仓库**，发版时 `git archive` 覆盖同步）；证书在 `~/bid/certs`（同步树之外）。
- **230 主机与容器时钟是 UTC**（mbp 是北京时间）：卡死判定/日志对齐一律以 SQL `at time zone 'Asia/Shanghai'` 为准。
- 公网带宽极差（21–75 KB/s）：页面慢先怀疑传输不是服务端。

## 标准发版：deploy-cust.sh（在 mbp 上跑）

```bash
# 本地推 main 后：
ssh mbp 'export PATH=/usr/local/bin:$PATH; nohup bash /Users/Administrator/bid/deploy/deploy-cust.sh <短commit> ["--only api,agent,web,admin"] > /tmp/bid-deploy.log 2>&1 &'
# 然后轮询日志等 ALLDONE|ABORT（ssh 断链不影响）
```

- **`--only` 连值整体加引号**（`"--only web"`）——不加引号 web 会被静默跳过却照样 ALLDONE（实翻过车，脚本现已拦截）。
- 脚本自带全部守护：mbp 出网预检 → **在途任务闸**（`project_steps status='running'` 非空即 abort）→ `tag-prev.sh` 回滚点 → 源码 `git archive` 同步 → nginx 配置校验 → 构建/投送 → 迁移 → 冒烟。任何一步失败都停在切流量之前，重跑无害。
- **web/admin 必须在 mbp 交叉构建 amd64**（230 出网拉不到 Google Fonts）；api/agent 在 230 原生构建（能访 PyPI）。`NEXT_PUBLIC_*` 是**构建期注入**，唯一来源是 230 的 `.env.deploy.local`，脚本构建前读它传 `--build-arg`——发版后验的是线上 chunk 内容，不是容器 env。
- **ALLDONE 不可单信**：发完必查 ① `docker ps` 各容器 Up 时间晚于发版时刻；② 容器内 grep 本次改动的关键标记（新函数名/新文案）。
- mbp 是笔记本：发版期间需**接电源 + 开盖**（合盖休眠 caffeinate 挡不住）。

**回滚**：`docker tag bid-<svc>:prev bid-<svc>:latest && $DC up -d <svc>`（`:prev` 由发版前的 `~/bid/ops/tag-prev.sh` 打）。清理镜像只用 `docker image prune -f`（**不带 -a**，`-a` 会把 `:prev` 删掉）。磁盘满先 `docker system df`。

**小静态文件热修**（图标之类）：可 `docker cp` 进运行容器立即生效，但**必须同时提交进仓库**——下次发版容器重建，未进仓库的热修会被抹掉。nginx 配置同理：改动必须先进仓库 `deploy/nginx-ip/`（发版会用仓库版覆盖 230）。

## 数据库迁移

迁移**手写**（drizzle snapshot 停在 ~0017，`db:generate` 会污染），手动 append `drizzle/meta/_journal.json`。
应用到客户库 231：新 api 镜像 up 之后 `docker exec bid-api-1 bun run drizzle-kit migrate`（容器 env 已指向 231；**必须先确认容器用的是含新 .sql 的新镜像**，否则空转还报 success）。

## 集成测试 / 开发库（HK，直连不走隧道）

60.205.160.74 到期后，开发数据面迁至 **HK 阿里云 47.239.15.54**，只绑 WireGuard 私网 **`10.66.66.1`**
（PG 5432 / Redis 6379 / MinIO 9000，容器名 bidsaas-dev-*）。本机 WG 直通，**testlocal/test-on-mbp 的隧道脚本已失效，别用**：

```bash
cd apps/api && bun --env-file=../../.env.bidsaas.local test [test/xxx.test.ts]   # 直连即可
```

`.env.bidsaas.local` 已指向 10.66.66.1。线上查数据/改 `billing_configs`：本地写 js 脚本经两跳 stdin 直灌
`ssh mbp 'ssh angeek@192.168.106.230 "docker exec -i bid-api-1 bun run -"' < 脚本`（import 用容器内绝对路径 `/app/apps/api/src/...`）。

## 密钥与配置

- 本地密钥只在 `.env.bidsaas.local`（gitignored）；模板 `.env.bidsaas.example` 只有变量名。仓库可能公开，**绝不提交真实凭据**（收钱吧参数、微信 AppSecret 等同理）。
- 230 运行时密钥在 `~/bid/app/deploy/.env.deploy.local`（api/agent 经 compose `env_file` 读取；改后 `up -d <svc>` 重建生效，先过在途任务闸）。230 SQB device=`an_bid_cust`。
- 微信扫码登录（spec004.2）：`WECHAT_APP_ID/SECRET` + `WECHAT_REDIRECT_URI=https://www.zhiqiyuan.cn/login/wechat`，两侧 env 都已配；微信开放平台后台的**授权回调域**须为 `www.zhiqiyuan.cn`。
- 站点 CSP 在 `deploy/nginx-ip/`：已放行滑块（`*.alicdn.com`/`*.aliyuncs.com`）与微信（`res.wx.qq.com`/`open.weixin.qq.com`）；新增第三方脚本先补 CSP 再上，缺条目是整功能瘫不是"不好用"。
- billing 配置在 DB `billing_configs`（运营后台可改、即生效）；首个超管 `bun run admin:bootstrap`。

## docs 同步 mbp（GitHub main 是权威，mbp 是便利副本）

```bash
rsync -aR docs README.md "mbp:/Users/Administrator/Documents/02-Work/anjikeji/Bid Assistant/"
```

远端带空格路径用普通双引号（反斜杠转义会静默失败）。
