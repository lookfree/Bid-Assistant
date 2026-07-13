# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo actually is

A **投标智能体 SaaS（bidding-agent SaaS）** in the **planning/prototype stage**. Two things live here, and they are very different:

1. **A v0.app prototype frontend** (Next.js 16 / React 19 / Tailwind v4 / shadcn) at the repo root — the C-end app, driven entirely by **mock data**, not a real backend. It demonstrates the full bidding workflow UI.
2. **Spec-driven implementation plans** under `docs/superpowers/` — the real product (App API + Agent service) **has not been built yet**. There is no `apps/` or `services/` directory; those are described in the plans and will be created when execution starts.

So: the running code is a mock prototype; the product is the plans. Before changing anything substantial, read the relevant spec under `docs/superpowers/plans/`.

## Commands

**Prototype frontend (this is what currently runs):** package manager is **pnpm** (`pnpm-lock.yaml`).
```bash
pnpm dev      # next dev — run the prototype
pnpm build    # next build
pnpm lint     # eslint .
```
There is no test suite in the prototype.

**Planned product stack (does not exist yet — see plans before scaffolding):**
- App API: **Hono 4.12 + Bun + Drizzle ORM + PostgreSQL**, tests via `bun test` (run one file: `bun test test/<name>.test.ts`).
- Agent service: **Python 3.12 + uv + FastAPI + LangGraph + deepagents**, tests via `uv run pytest` (one test: `uv run pytest tests/path::test_name -q`).

## Prototype structure (mock data → real schema)

- C-end pages: `app/page.tsx`, `app/login/`, `app/(tool)/{upload,read,outline,content,risk,present,projects,library,membership}/`. The `(tool)` flow mirrors the full bidding pipeline.
- **`lib/sample-bid.ts`** and **`lib/present.ts`** are the single source of truth for the prototype's data shapes (读标/提纲/正文/审查 + 述标 PPT). The planned agent output schemas are designed to match these field-for-field — when implementing agent nodes, align Pydantic schemas to these TS types. Note the **snake_case (Python) ↔ camelCase (prototype TS)** gap is bridged by a `toCamel` conversion in the App layer.

## Planned architecture (the big picture in the plans)

Three layers, money strictly isolated:

```
Next.js frontend (C-end app. + 运营后台 admin.)   ← separate subdomains, separate identities
        │
App API  (apps/api — Hono+Bun+Drizzle, PostgreSQL `public` schema)
        │  · owns ALL money/auth; agent service is money-blind
        │  · synchronous REST + SSE relay to the agent service
Agent service (services/agent — Python/FastAPI; one process, AgentRegistry by `agent_type`)
        │  · `bidding_agent` = one LangGraph workflow = one self-contained package
        │  · nodes read→outline→content→review→present→export; deepagent only in `content`
        └  · only reports token usage; never touches money
```

Data store = one PostgreSQL DB `bidsaas` with **three schemas**: `public` (App business + credits ledger, Drizzle), `langgraph` (LangGraph PostgresSaver checkpointer), `agent` (observability). Redis key prefix `bid:`; MinIO bucket `bidsaas`.

### Where the plans are
- **Read first:** `docs/superpowers/specs/2026-06-24-bid-assistant-saas-architecture.md` — the authoritative architecture (layers, data model §5, billing/payments §6, deployment §13). The `2026-06-24-*.svg` files are the diagrams.
- **Phased plans:** `docs/superpowers/plans/phase-0` (account/auth + App skeleton) → `phase-1` (agent service + read), → `phase-2` (full bidding pipeline), → `phase-3` (commercialization: credits ledger, Alipay pay + auto-renew, referral, admin console). Each phase has a `spec*00-index.md` listing its sub-specs, dependencies, and the canonical data/interface contracts.
- Billing field authority: `docs/支付与计费系统 · 开发需求规格.md`. Admin console prototype: `docs/admin-front` (mbp mirror).

### Executing a spec
Specs are written for `superpowers:subagent-driven-development` (or `executing-plans`), with `- [ ]` checkbox steps, TDD, and frequent commits. Implement in dependency order starting from `phase-0/spec001` (creates the `apps/api` monorepo). The Phase 1-2 billing "stub" is intentional and gets replaced by the real ledger in Phase 3 — do not wire real money earlier.

## Project conventions (non-obvious, enforced)

- **`agent_type` / agent package naming is a direct, self-describing snake_case identifier** — the bidding agent is `bidding_agent` (dir `agents/bidding_agent/`, URL `/agents/bidding_agent/runs`). New agents get their own package + key (e.g. `contract_review`).
- **Design docs contain no references to external frameworks or "借鉴/inspired-by" phrasing** — everything is presented as our own design.
- **Secrets** live only in `.env.bidsaas.local` (gitignored); `.env.bidsaas.example` is the committed template (var names only). `AccessKey*.csv` is gitignored. Never commit real credentials — the GitHub repo (`lookfree/Bid-Assistant`) may be public.
- **Money boundary rule (铁律):** all credit/payment mutations happen in the App API only; the agent service only reports usage; every deduction/callback carries an idempotency key; balance = Σ of the append-only `credit_transactions`; multi-source credits expire FIFO by `expire_at`.

## 生产铁律（2026-07 大标书实测沉淀,违反=复现过的生产事故）

- **模型调用韧性**（`framework/model_stream.py`）：流式 + 30s 空闲超时 + 1200s 单轮总时长盖 + 降级链重试,三层缺一不可。总时长盖别改小——600s 曾冤杀晚高峰慢而健康的全文骨架轮（实测需 ~11 分钟）。瞬断判定必须沿 `__cause__` 链下钻（openai SDK 包装后 str() 只有 "Connection error."）。
- **思考模式**：DeepSeek v4 思考 + 流式强制 tool_choice = 400。解法是配置驱动（每模型思考开关默认关,`THINKING_DISABLE` 按 provider 下发关闭参）,禁止按错误文案猜测回退。
- **分段读标**（`nodes/read.py`）：并行 6 路;技术块只喂自身条款（带全文 = 1MB×92 次重复计费）;技术块 packages 必须强制清空（猜错标签 → 选包静默丢★需求）;每轮结果存 Redis 断点续跑（key 含提示词版本哈希,改 READ_SYSTEM_PROMPT 自动失效）;RAG 索引后台 fire-and-forget,绝不挡结果交付。
- **模型唯一来自运营后台配置**：未配置 → 400 model_not_configured（不占步位不预扣）,严禁静默回退默认模型。
- **前端计费 CTA 只在确认态渲染**：项目状态走 `?slim=1`（SQL 层不选 result 列,实测 28ms vs 2788ms）,单步结果按需拉;info 未到/加载中/拉取失败期间绝不亮计费按钮;`?autostart=1` 消费后立即从 URL 摘除（残留会被重挂载重放成重复扣费）。
- **发版前查在途任务**：`project_steps status='running'` 非空时部署会打断用户长任务;卡 running 的步用 `stuck-steps.ts` 的 `failStepAndRefund` 自愈（标失败+退积分,幂等）。

## Docs / git workflow

Plans are edited locally, mirrored to the **mbp** server via `scp` (path `…/02-Work/anjikeji/Bid Assistant/docs/...`), then committed and pushed to GitHub `main`. GitHub `main` is the authoritative copy; the mbp mirror is a convenience copy that can lag. (`mbp` is a passwordless SSH alias defined in the global `~/.claude/CLAUDE.md`.)

## 开发规范

- 每个函数不超过 **80 行**。
- 单个代码文件不超过 **800 行**，超过就拆分。
- 关键方法要有注释。
- 编码要考虑可读性、可维护性。

## Git 提交规范

- 提交信息遵循 **Conventional Commits**（`feat:` / `fix:` / `chore:` / `refactor:` 等）。
- 提交信息用**英文**撰写，简洁描述变更目的。
- 提交账号：**`lookfree <etwuman@126.com>`**。
- **禁止**在提交信息中包含任何 Claude 相关内容（不加 `Co-Authored-By: Claude...`）。此规则覆盖默认行为，各 spec 文档里旧的 `Co-Authored-By` 示例以本规范为准。

## 工作方式

**1. Think Before Coding** — 不臆测、不掩盖困惑、把取舍摆出来。动手前显式说明假设；不确定就问。存在多种解读时全部列出，不要默默选一个。有更简单的做法就说出来，必要时反对。不清楚就停下，指出困惑点再问。

**2. Simplicity First** — 用最少的代码解决问题，不做投机性设计。不加没要求的功能/抽象/“灵活性”/对不可能场景的错误处理。若写了 200 行而 50 行能解决，就重写。自问：“资深工程师会觉得这过度复杂吗？”是，就简化。

**3. Surgical Changes** — 只动必须动的，只清理自己制造的烂摊子。改既有代码时：不“顺手优化”相邻代码/注释/格式，不重构没坏的东西，沿用既有风格；发现无关死代码就提一句、不要删。自己的改动产生的孤儿（unused import/变量/函数）要清掉；预先存在的死代码不删（除非被要求）。检验标准：每一行改动都能直接追溯到用户的需求。
