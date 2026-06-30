# 投标智能体 SaaS（monorepo）

Bun workspaces 单仓多包。

- `apps/web`   C 端用户前端（Next.js，复用原型）
- `apps/admin` 运营管理后台（Next.js，基于 admin-front 原型，端口 3001）
- `apps/api`   App API（Hono + Bun）—— 钱的唯一权威（spec002 起）
- `services/agent` 智能体服务（Python + LangGraph/deepagents，Phase 1）
- `packages/*` 跨端共享（类型/契约）
- `docs/`     架构方案与实现计划（`docs/superpowers/specs`、`docs/superpowers/plans`）

## 开发

```bash
bun install
bun run web      # C 端，:3000
bun run admin    # 运营后台，:3001
bun run typecheck
```

中间件连接见 `docs/superpowers/specs/2026-06-24-bid-assistant-saas-architecture.md` §14 与根 `.env.bidsaas.local`（不入库，模板见 `.env.bidsaas.example`）。开发约定见 `CLAUDE.md`。
