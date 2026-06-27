# spec001 · Monorepo 重构 + 工具链 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前"单个 Next.js 原型仓库"重构成 Bun workspaces monorepo：C 端原型迁入 `apps/web`、运营后台原型迁入 `apps/admin`，建立根级工具链，为后续 `apps/api`（Hono）与 `services/agent`（Python）留好位置。

**Architecture:** Bun workspaces 管理多包；前端两套（web/admin）保持原样可构建；新增 `apps/api`、`packages/*`、`services/agent` 目录占位。本 spec 不改任何前端业务行为，只搬家 + 配工具链。

**Tech Stack:** Bun ≥1.2.16、TypeScript strict、Next.js 16（web/admin）、根级 tsconfig/Prettier/ESLint。

## Global Constraints

见 `spec000-index.md` 的 Global Constraints。本 spec 关键约束逐条：
- 运行时 Bun ≥ 1.2.16；TS `strict: true`。
- 不引入 native 模块。
- 前端复用现有原型，**不改业务行为**（搬家后构建结果一致）。
- 频繁提交；提交信息结尾 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 在 `main` 上先开分支再改。

---

## File Structure（重构后目标布局）

```
Bid Assistant/                      # 仓库根 = workspace 根
├── package.json                    # 新：workspaces 根，private，scripts
├── bunfig.toml                     # 新：Bun 配置
├── tsconfig.base.json              # 新：共享 TS 基线
├── .prettierrc.json                # 新
├── .gitignore                      # 改：补 bun/turbo 产物
├── apps/
│   ├── web/                        # 迁入：原根目录的 Next.js C 端原型
│   │   ├── package.json            # 改名 @bid/web
│   │   ├── app/ components/ hooks/ lib/ public/ scripts/
│   │   ├── next.config.mjs postcss.config.mjs components.json
│   │   └── tsconfig.json           # extends ../../tsconfig.base.json
│   ├── admin/                      # 迁入：docs/admin-front
│   │   ├── package.json            # 改名 @bid/admin
│   │   └── app/ components/ hooks/ lib/ public/ ...
│   └── api/.gitkeep                # 占位（spec002 填充）
├── packages/
│   ├── shared/.gitkeep             # 占位：跨端共享类型（后续）
│   └── .gitkeep
├── services/
│   └── agent/.gitkeep              # 占位：Python 智能体服务（后续 Phase 1）
└── docs/                           # 不动（设计文档/计划）
```

> 说明：原仓库根的 `app/ components/ hooks/ lib/ public/ scripts/ components.json next.config.mjs postcss.config.mjs tsconfig.json package.json pnpm-lock.yaml tsconfig.tsbuildinfo` 全部属于 C 端原型，整体迁入 `apps/web/`。`docs/` 留在根。

---

## Interfaces（本 spec 对外产出，供后续 spec 依赖）

- Produces:
  - 根 `package.json` 含 `"workspaces": ["apps/*", "packages/*"]`，可 `bun install`。
  - `tsconfig.base.json`：被各包 `extends`，提供 `strict`、路径别名基线。
  - 目录约定：App API 落 `apps/api`，共享代码落 `packages/shared`，Python 服务落 `services/agent`。
  - 根 scripts：`bun run web`、`bun run admin`（后续追加 `api`）。

---

## Task 1: 创建工作分支 + workspace 根脚手架

**Files:**
- Create: `package.json`（仓库根，覆盖原前端 package.json —— 注意原 package.json 先移走，见 Task 2，故此处先用临时根）
- Create: `bunfig.toml`、`tsconfig.base.json`、`.prettierrc.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: 可被 `bun install` 识别的 workspace 根。

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase0/spec001-monorepo
```

- [ ] **Step 2: 先把原前端文件移入 `apps/web`（避免根 package.json 冲突）**

```bash
mkdir -p apps/web apps/admin apps/api packages/shared services/agent
git mv app components hooks lib public scripts components.json \
       next.config.mjs postcss.config.mjs tsconfig.json package.json \
       pnpm-lock.yaml apps/web/ 2>/dev/null || true
# tsconfig.tsbuildinfo 是构建产物，删掉不迁
git rm --cached tsconfig.tsbuildinfo 2>/dev/null || true
rm -f tsconfig.tsbuildinfo
```

- [ ] **Step 3: 写 workspace 根 `package.json`**

```json
{
  "name": "bid-assistant",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "packageManager": "bun@1.3.0",
  "engines": { "bun": ">=1.2.16" },
  "scripts": {
    "web": "bun --filter @bid/web dev",
    "admin": "bun --filter @bid/admin dev",
    "build": "bun --filter '*' build",
    "format": "prettier --write .",
    "typecheck": "bun --filter '*' typecheck"
  },
  "overrides": { "hono": "4.12.25" },
  "devDependencies": { "prettier": "^3.3.0", "typescript": "^5.6.0" }
}
```

- [ ] **Step 4: 写 `bunfig.toml`**

```toml
[install]
# 锁注册表，加速国内安装（可按需替换）
registry = "https://registry.npmmirror.com"
exact = false
```

- [ ] **Step 5: 写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 6: 写 `.prettierrc.json`**

```json
{ "semi": false, "singleQuote": false, "printWidth": 100, "trailingComma": "all" }
```

- [ ] **Step 7: 追加 `.gitignore`**

在文件末尾追加：

```gitignore
# bun / monorepo
.turbo/
*.tsbuildinfo
apps/*/.next/
node_modules/
```

- [ ] **Step 8: 验证 workspace 可被解析（暂不装全部依赖）**

Run: `bun pm ls 2>&1 | head -5 || true`
Expected: 不报 "workspace" 解析错误（此时 apps/web/package.json 名称未改，下一任务修）。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "chore(spec001): bun workspace 根脚手架 + 原前端迁入 apps/web

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 修正 `apps/web` 为工作区包并验证构建

**Files:**
- Modify: `apps/web/package.json`（改 name、移除 lockfile 依赖差异）
- Modify: `apps/web/tsconfig.json`（extends 根 base）

**Interfaces:**
- Consumes: Task 1 的 workspace 根。
- Produces: `@bid/web` 包，可 `bun install` + `bun --filter @bid/web build`。

- [ ] **Step 1: 改 `apps/web/package.json` 的 name**

把 `"name"` 改为 `"@bid/web"`，并删除 `"packageManager"`/`pnpm` 专属字段（若有）。保留 `dependencies`/`devDependencies`/`scripts`。确保 `scripts` 含：

```json
{
  "name": "@bid/web",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: 让 `apps/web/tsconfig.json` 继承根 base**

在 `apps/web/tsconfig.json` 顶部加 `"extends": "../../tsconfig.base.json"`（保留其原有 Next.js 专属 `compilerOptions`/`include`/`plugins`，extends 仅做基线合并）。

- [ ] **Step 3: 删除迁入的 `apps/web/pnpm-lock.yaml`（统一用 Bun）**

```bash
git rm apps/web/pnpm-lock.yaml
```

- [ ] **Step 4: 安装依赖**

Run: `bun install`
Expected: 生成根 `bun.lockb`，无 native 编译报错。

- [ ] **Step 5: 验证 web 构建通过**

Run: `bun --filter @bid/web build`
Expected: Next.js build 成功（与重构前一致，无新增报错）。

- [ ] **Step 6: 验证 web 可起 dev（冒烟）**

Run: `bun run web`（起后 `curl -sI http://localhost:3000 | head -1` 应为 `HTTP/1.1 200`，确认后 Ctrl-C）
Expected: 落地页可访问。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore(spec001): apps/web 入工作区(@bid/web)，bun 构建通过

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 导入运营后台原型到 `apps/admin`

**Files:**
- Create: `apps/admin/*`（来自 mbp 的 `docs/admin-front`）
- Modify: `apps/admin/package.json`（改 name `@bid/admin`）、`apps/admin/tsconfig.json`

**Interfaces:**
- Consumes: workspace 根。
- Produces: `@bid/admin` 包，可构建。

- [ ] **Step 1: 从 mbp 拉取 admin-front 到 apps/admin**

```bash
# admin-front 当前在 mbp，非本地仓库；拉取（排除 node_modules/.next/lockfile）
rsync -a --exclude node_modules --exclude .next --exclude '*.lock' --exclude pnpm-lock.yaml \
  "mbp:/Users/Administrator/Documents/02-Work/anjikeji/Bid Assistant/docs/admin-front/" apps/admin/
```

- [ ] **Step 2: 改 `apps/admin/package.json` name + scripts**

```json
{
  "name": "@bid/admin",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001",
    "typecheck": "tsc --noEmit"
  }
}
```

> **访问拓扑（架构 §3.3）**：`3000/3001` 仅为**开发期**双端口，避免本地冲突。**生产期**两端走**不同子域名**（`app.<域名>` / `admin.<域名>`）由反代/Ingress 路由，后台子域另加 IP 白名单/内网管控——非靠对外暴露不同端口。spec007 容器化/Ingress 落地双子域。

- [ ] **Step 3: `apps/admin/tsconfig.json` 继承根 base**

加 `"extends": "../../tsconfig.base.json"`。

- [ ] **Step 4: 重新安装并验证 admin 构建**

Run: `bun install && bun --filter @bid/admin build`
Expected: admin Next.js build 成功。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(spec001): 导入运营后台原型 apps/admin(@bid/admin)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 占位目录 + 根 README + 整体校验

**Files:**
- Create: `apps/api/.gitkeep`、`packages/shared/.gitkeep`、`services/agent/.gitkeep`
- Create: `README.md`（仓库根，简述结构）

**Interfaces:**
- Produces: 后续 spec 的落地目录约定。

- [ ] **Step 1: 建占位文件**

```bash
touch apps/api/.gitkeep packages/shared/.gitkeep services/agent/.gitkeep
```

- [ ] **Step 2: 写根 `README.md`**

```markdown
# 投标智能体 SaaS（monorepo）

- `apps/web`   C 端用户前端（Next.js，复用原型）
- `apps/admin` 运营管理后台（Next.js，基于 admin-front 原型）
- `apps/api`   App API（Hono + Bun）—— 钱的唯一权威（spec002 起）
- `services/agent` 智能体服务（Python + LangGraph/deepagents，Phase 1）
- `packages/*` 跨端共享（类型/契约）
- `docs/`     架构方案与实现计划（superpowers/specs、superpowers/plans）

开发：`bun install` → `bun run web` / `bun run admin`
中间件连接见 `docs/.../§14` 与根 `.env.bidsaas.local`（不入库）。
```

- [ ] **Step 3: 全量类型检查（两端）**

Run: `bun run typecheck`
Expected: web、admin 各自 `tsc --noEmit` 通过（无新增类型错误）。

- [ ] **Step 4: 确认 `.env.bidsaas.local` 仍被忽略**

Run: `git check-ignore .env.bidsaas.local`
Expected: 输出 `.env.bidsaas.local`（被忽略）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore(spec001): 占位目录 apps/api·packages·services + 根 README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: 合并回 main 并推送**

```bash
git checkout main
git merge --no-ff phase0/spec001-monorepo -m "merge spec001: monorepo 重构"
git push origin main
```

---

## 验收清单（spec001 完成判据）

- [ ] `bun install` 在仓库根成功，生成 `bun.lockb`。
- [ ] `bun --filter @bid/web build` 与 `bun --filter @bid/admin build` 均成功。
- [ ] `bun run web` 落地页 200；`bun run admin` 后台可起。
- [ ] `bun run typecheck` 两端通过。
- [ ] 目录结构符合 File Structure；`apps/api`/`packages/shared`/`services/agent` 占位就位。
- [ ] `.env.bidsaas.local` 未入库。
