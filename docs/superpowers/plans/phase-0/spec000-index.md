# Phase 0 · 地基 —— 实现计划索引（spec000）

> 本目录把架构方案 §8 的 **Phase 0** 细化为 spec001–spec007，每个 spec 是一份可独立执行、独立测试的实现计划。
> 上游设计基线：`docs/superpowers/specs/2026-06-24-bid-assistant-saas-architecture.md`
> **Phase 0 产出目标**：能登录、能上传文件、能部署（端到端跑通骨架，计费用 stub 占位）。

## spec 清单与依赖顺序

| spec | 主题 | 交付物（可测） | 依赖 |
|---|---|---|---|
| **spec001** | Monorepo 重构 + 工具链 | Bun workspaces；现有 C 端原型→`apps/web`、admin-front→`apps/admin`；根 tsconfig/lint/format/test 就位；`bun install` 通过、两端仍能构建 | — |
| **spec002** | App API 骨架（Hono+Bun） | `apps/api` 起服务；`GET /healthz` 200；env(Zod) 校验；Drizzle 连通 PG16 `bidsaas`；`GET /readyz` 探活 DB | spec001 |
| **spec003** | 鉴权数据模型 + 迁移 | `users`(账号本体) + `user_identities`(可插拔身份·为微信等预留) + `sessions`；迁移到 bidsaas；用户/身份/会话仓储 | spec002 |
| **spec004** | 手机号验证码鉴权 | 阿里云短信发码/校验、不透明 Bearer 令牌（落 `sessions` 可撤销）、`/auth/*` + 鉴权中间件；**未注册手机号验证通过即自动建号（需协议同意，返回 isNew）**；**防刷：滑块默认开 + 限频四层默认关可逐开** | spec003 |
| **spec004.1** | 滑块验证码落地 | 真实阿里云验证码2.0 校验器（`@alicloud/captcha20230305`）+ 前端滑块组件；待验证码凭据就绪写 | spec004、spec005 |
> **注：spec004.1（滑块验证码落地）** ——独立文件待写（验证码凭据就绪后补），当前已并入 **spec004 的「防刷：滑块默认开」章节**作为占位实现；此处仅登记，消除悬空引用。
| **spec004.2** | 微信扫码登录 | 微信开放平台 OAuth（unionid 找/建账号、复用 `user_identities(wechat)` 零 schema 改动）、`/auth/wechat/*` + 前端二维码/回调页；开发期伪客户端可联调 | spec003、spec005 |
| **spec005** | 前端接入登录 | `apps/web` `/login` 接真实 `/auth/*`，登录态持久化 + 路由守卫，端到端登录 | spec004 |
| **spec006** | 文件直传（MinIO/S3） | File 模块预签名直传/直下（bucket `bidsaas`）、`project_files` 元数据、接 `/upload` | spec004 |
| **spec007** | 容器化与部署 | `oven/bun` Dockerfile、本地 compose、部署到服务器、基础 CI、**反代双子域路由**（`app.`/`admin.` → web/admin，§3.3） | spec002–006 |

> 关键路径：001→002→003→004 是主链；005/006 可在 004 后并行；007 收尾。

---

## Global Constraints（全局约束 · 每个 spec 隐含包含）

**运行时与语言**
- App 层运行时 **Bun ≥ 1.2.16（建议 1.3.x）**；语言 TypeScript（`strict: true`）。
- 主动避开 native 模块（无 node-gyp）：密码哈希用 `Bun.password`，不用 `bcrypt`/`sharp`/旧 `sqlite3`。

**App API 技术栈**
- Web 框架 **Hono `4.12.25`**（与原型 `package.json` overrides 锁定一致，运行时无关）。
- ORM **Drizzle**（纯 JS）+ 驱动 `postgres`（postgres-js，纯 JS）。
- 校验 **Zod**。鉴权：**不透明 Bearer 令牌**（随机串，DB 只存 sha256 哈希）+ DB `sessions`（可撤销）；如后续需无状态校验（如智能体服务免查库）再叠 JWT 接入层。

**数据与中间件（已就绪，详见架构 §14；真实值在仓库根 `.env.bidsaas.local`，已 gitignore）**
- PostgreSQL **16.1 + pgvector**，库 `bidsaas`，schema `public`(业务+账本) / `langgraph`(后续 checkpointer)。
- Redis：复用实例，约定 `REDIS_DB=3` + key 前缀 `bid:`。
- MinIO（S3 兼容）：bucket `bidsaas`，预签名 URL 直传/直下。
- 短信：阿里云 `@alicloud/dysmsapi20170525`（纯 JS）。
- 所有连接串/密钥**只从环境变量读**，禁止硬编码、禁止入库真实密钥。

**前端**
- `apps/web`：Next.js 16 + React 19 + Tailwind v4 + shadcn/ui（复用现有 C 端原型）。
- `apps/admin`：基于 `docs/admin-front` 原型（运营后台，Phase 0 仅迁入工作区，不接后端）。

**边界铁律（架构 §3.2，贯穿全程）**
- 钱只有一个权威 = App API；智能体服务对业务无知；长任务异步 + SSE。
- Phase 0 计费用 **stub 钩子**占位（预扣/结算空实现），不接真账本。

**工程纪律**
- TDD：每个功能先写失败测试再实现；测试用 **Bun 内置 test runner**（`bun test`）。
- 频繁提交；提交信息结尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 在默认分支上先开分支再改（当前 `main`）。

---

## 执行方式

每个 spec 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现。spec 内步骤用 `- [ ]` 复选框跟踪。
