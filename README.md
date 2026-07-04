# 投标智能体 SaaS（monorepo）

C 端投标智能体 SaaS。Bun workspaces 单仓多包，钱严格隔离在 App API 一层。

## 结构

- `apps/web`   C 端用户前端（Next.js 16 / React 19 / Tailwind v4；路由组 `app/(tool)/*` 共享工具外壳）
- `apps/admin` 运营管理后台（Next.js，:3001，spec309/310 建设中）
- `apps/api`   App API（Hono 4.12 + Bun + Drizzle + PostgreSQL）—— **钱/鉴权的唯一权威**，智能体只上报用量
- `services/agent` 智能体服务（Python + FastAPI + LangGraph/deepagents）
- `packages/shared` 跨端共享类型/契约
- `docs/`     架构方案（`docs/superpowers/specs`）与分阶段实现计划（`docs/superpowers/plans/phase-0..3`）

## 开发

```bash
bun install
bun run web        # C 端，:3000
bun run admin      # 运营后台，:3001
bun run api        # App API，:8080
bun run typecheck  # 全包类型检查
bun run format     # prettier
```

App API 集成测试连远程真实 PG/Redis/MinIO，**在 mbp 上经 SSH 隧道跑**（本机直连丢包）：

```bash
./test-on-mbp.sh                              # 全量
./test-on-mbp.sh test/services/membership.test.ts  # 单文件
```

## 进度

- **Phase 0–2**：账号鉴权 + App 骨架、智能体服务（`services/agent` 的 `bidding_agent`：读标→提纲→正文→审查→述标→导出）已实现。
- **Phase 3 商业化**：积分账本、收钱吧 C 扫 B 支付（真实 1 分钱冒烟已过）、到期提醒+手动续费、对账/退款/过期、推荐奖励引擎、C 端会员中心均已合并 `main`；运营后台（`apps/admin`，spec309/310）待建。

## 约定（铁律）

- **钱只在 App API 动**：所有积分/支付变更走 `apps/api`；智能体服务只上报用量；每笔扣减/回调带幂等键；余额 = append-only `credit_transactions` 之和。
- 金额全链路整数分，禁浮点存储。

中间件连接见 `docs/superpowers/specs/2026-06-24-bid-assistant-saas-architecture.md` §14 与根 `.env.bidsaas.local`（不入库，模板 `.env.bidsaas.example`）。完整开发约定见 `CLAUDE.md`。
