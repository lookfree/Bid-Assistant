---
name: api-service-dev
description: 开发/迭代 App API（apps/api，Hono+Bun+Drizzle+PostgreSQL）时使用——含钱的唯一权威层、鉴权、账本、支付、订阅、推荐、运营后台 API。涉及新增路由/服务/仓储/schema/迁移、动钱逻辑、写测试时必读。
---

# App API 开发（apps/api）

**这是钱与鉴权的唯一权威层。** 所有积分/支付/订阅变更只在这里发生；智能体服务只上报用量。动钱的每一行都要严谨。

## 技术栈与结构

- Hono 4.12 + Bun + Drizzle ORM + PostgreSQL（`public` schema）+ Zod + `bun:test`。
- `src/db/schema/*` 表定义（barrel `src/db/schema/index.ts` 汇出）；`src/repos/*` 仓储；`src/services/*` 业务；`src/routes/*` 路由；`src/middleware/*` 中间件；`src/crons/*` 定时任务；`src/config/*` 种子；`drizzle/*.sql` 迁移。
- `src/app.ts` 导出 `createApp(deps)`（**不是**现成的 `app` 实例）。路由用工厂函数（`xxxRoutes()`）在 `createApp` 里 `app.route("/api/xxx", xxxRoutes())` 挂载。

## 关键约定（踩坑点，务必遵守）

1. **DB 句柄用 `getDb()`**——`db/client` 导出的是 `getDb()`，不是 `db`。事务 `getDb().transaction(async (tx) => …)`；`type Tx` 从 `services/credits` 导出。
2. **schema 不用 `pgEnum`**（users/user_identities 是历史遗留）——新表用 `columns` helper（`id()` / `tz(name)` / `createdAt()`）+ `text("x").$type<Union>()` + `check(...)` 约束 + `const XS = [...] as const` 元组派生类型。参照 `plans.ts`/`sessions.ts`/`admin.ts`。
3. **迁移手写、别用 `db:generate`**——drizzle 的 snapshot 停在 ~0017（0018 起是手写迁移没更新 snapshot），`db:generate` 会把既有表重复 emit 且产出无 `IF NOT EXISTS` 的 `ADD COLUMN`（应用即失败）。做法：手写 `drizzle/00NN_name.sql`（`CREATE TABLE IF NOT EXISTS` / 内联 FK / 幂等）+ 用 python 往 `drizzle/meta/_journal.json` 追加一条 `{idx, tag}`。**当前最高 0021**。应用见下方「测试与迁移」。
4. **测试自建 Hono、别 import app**——端到端测试 `const app = new Hono(); app.route("/api/xxx", xxxRoutes(deps))`，用 `app.request("http://x/api/xxx", …)`。需要 mock 的依赖（支付 provider）从工厂参数注入，别打真实通道。
5. **分页统一**——路由用 `lib/pagination` 的 `parsePagination`（pageSize 上限 100 + 校验，非裸 `Number()`）+ `pagedBody`（补 hasMore）；服务返回 `{items,total}`（可用 `pagedResult(itemsQuery, countQuery)`）。

## 钱的铁律（和钱相关的要严谨）

- **余额 = Σ `credit_transactions`.amount**（append-only 账本）；`credit_balances` 只是缓存+对账。
- **每笔扣减/回调/入账带幂等键**（DB 唯一约束兜底）；金额一律**整数分**，禁浮点存储。
- **`credits.grant` 只收正值**（`amount<=0` 抛错）；带符号调整（运营手动加/扣）走 `credits.adminAdjust`（行锁串行化、负向不扣穿到负、幂等）。
- **并发串行化点**：动同一用户余额用 `lockUserBalanceRow(tx, userId)`（`credits.ts`）；订阅续费用 `subscriptions` 的 `unique(user_id)` + `FOR UPDATE`；推荐封顶读+发放同一事务同一把行锁。
- **两段扣费**（AI 操作）：`hold(-N)` 预扣 → `settle`（多退少补）/ `release`（全退）；每个 hold 至多一条了结（部分唯一索引）。
- **支付**：收钱吧 C 扫 B（`/upay/v2/precreate` 返 `qr_code`）；服务端定价快照，不信客户端金额；回调 RSA 验签；结果轮询兜底；`markPaid` 单赢家（conditional UPDATE）+ 幂等；退款歧义（通道超时）→ pending（不是 failed，防双退）。
- **审计**：运营后台所有敏感写调 `services/audit.writeAudit({operator, action, target, before, after})`。

## 鉴权

- C 端：`middleware/auth.authMiddleware` 解析 Bearer → `c.set("user", user)`（查 `sessions`，token 只存 sha256）。取 id 用 `lib/auth-user.getUserId(c)`。
- 运营后台**完全隔离**：`admin_sessions`/`admin_users`（独立表）+ `/admin-api` 前缀 + `middleware/admin-auth` 的 `requireAdmin(...roles)` / `requirePermission(perm)`（未认证 401 / 越权 403）；RBAC 映射在 `services/rbac`。C 端 token 打 admin-api 必 401。
- token sha256 哈希共用 `services/crypto.sha256Hex`。

## 命令

```bash
bun run api          # 起服务 :8080
bun run typecheck    # tsc（先跑，快）
bun run admin:bootstrap  # 建首个 superadmin（env: ADMIN_BOOTSTRAP_USERNAME/PASSWORD）
```

## 测试与迁移（连真库 → 必经 mbp 隧道）

集成测试连远程真实 PG/Redis/MinIO，**在 mbp 上经 SSH 隧道跑**（本机走 VPN 到国内阿里云丢包，直连会随机超时）：

```bash
./test-on-mbp.sh                                   # 全量（合并门禁）
./test-on-mbp.sh test/services/xxx.test.ts …       # 单/多文件
```

新迁移经隧道应用（同步 apps/api 到 mbp → 建隧道 → `drizzle-kit migrate` 用 127.0.0.1:15432）：见 `test-on-mbp.sh` 里的隧道命令，或手动 `ssh mbp` 里 export 改写后的 DATABASE_URL 再 `bun run drizzle-kit migrate`。**别从本机直连远程 PG 跑迁移。**

## 迭代节奏（本项目铁流程）

**实现（TDD，先写失败测试）→ `/code-review`（全修，钱相关从严）→ `/simplify` → mbp 全绿 → 合并 main + 推送。** 每个 spec 一个分支 `phase3/specNNN-*`。审查/简化的 findings 一律全修（钱路径的并发/幂等尤其）。提交：英文 Conventional Commits、账号 `lookfree`、**不加 Co-Authored-By**（覆盖各 spec 文档旧示例）。

## 参照

架构 `docs/superpowers/specs/2026-06-24-*.md`；分阶段计划 `docs/superpowers/plans/phase-*`（每个 spec 头部有「实现校正」总述对齐代码库）；遗留台账 `docs/review-followups.md`；根 `CLAUDE.md`。
