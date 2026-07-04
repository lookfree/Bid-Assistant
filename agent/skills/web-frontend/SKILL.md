---
name: web-frontend-dev
description: 开发/迭代 C 端用户前端（apps/web，Next.js 16 + React 19 + Tailwind v4 + shadcn）时使用——投标工具流、会员中心、登录、接 App API。新增页面/组件、接后端接口、改登录/支付/邀请入口时读。
---

# C 端前端开发（apps/web）

C 端用户应用：投标全流程工具 + 会员中心。**前端只渲染，钱与身份都在 App API。**

## 技术栈与结构

- Next.js 16 / React 19 / Tailwind v4 / shadcn/ui / lucide-react。**前端在 `apps/web`，不是仓库根。**
- `app/(tool)/*` 是 **Next.js 路由组**（括号名不进 URL，共享 `(tool)/layout.tsx` 工具外壳）：upload/read/outline/content/risk/present/projects/library/membership。`app/login` 单独。**括号是框架约定,别当笔误删掉**（删了要么改 URL、要么丢共享布局）。
- `lib/`：`api-client.ts`（`createApiClient({baseUrl,getToken,fetchImpl,onUnauthorized})`，含 401 语义）；`api.ts`（单例 `api`，读 `NEXT_PUBLIC_API_BASE_URL`）；`token-store.ts`（localStorage key `bid.token`）；`plans.ts`（TierId/Feature/memberTiers/creditPacks/creditCosts——产品静态目录/文案的单一来源）；`membership-api.ts`/`membership-types.ts`/`membership-view.ts`（会员中心接线）。

## 关键约定

1. **接口封装建在 `api.request` 上**——别各页裸 `fetch`。工厂形式（`createXxxApi(request)` + 绑定单例的默认实例）便于 `fetchImpl` 注入测试。带状态码的错误用 `AdminApiError`/`ApiError` 便于区分 401 vs 瞬时错误。
2. **金额**：后端出参是 `*_cents`（分）+ `*Yuan`（元）；展示用元。整数分口径。
3. **复用优先**：先用原型现成的 shadcn 组件（`components/ui`：Button/Input/Card/Label…）和 `lib/plans.ts` 的目录/文案；原型不够的才在其基础上加。营销文案（tier features 文本）在前端 `memberTiers`，后端只给价格/额度真值。
4. **服务端定价**：充值/续费只传 `packId`/`planId` + `payway`（"alipay"/"wechat"），金额后端定；充值包目录由后端 `overview.rechargePacks` 驱动（别用前端静态 id，会和后端 config 的 id 不一致 → 400）。会员续费按月/年切换取对应 `planIdMonth`/`planIdYear`（别用单个 id，年付会误按月价）。
5. **邀请链接**：`/login?ref=CODE` → 登录页读 `searchParams.get("ref")` → `verifySmsCode(phone, code, agreed, referralCode)`；后端首次注册绑定推荐关系。
6. **401**：`onUnauthorized` 清 token + 复位登录态（一产一消回调，`setAuthExpiredHandler`）。

## 命令与测试

```bash
bun run web        # :3000
bun run typecheck  # 全包 tsc
```

纯函数/封装用 `bun test test/`（mock fetch 用 `fetchImpl` 注入；见 `test/api-client.test.ts`、`test/membership-api.test.ts`）。**`tsconfig.json` 的 exclude 含 `test`**（bun:test 由运行时解析，不进 tsc）——新增 test 目录若报 `bun:test` 找不到，检查 exclude。UI 渲染部分靠 tsc + 人工；把可测的纯展示/映射逻辑抽到 `lib/*-view.ts` 单测（如 `membership-view.ts` 的 formatPeriodEnd/tierCardState）。

## 迭代节奏

实现 → `/code-review` → `/simplify` → `bun test` + tsc 全绿 → 合并。提交规范同仓库（英文 Conventional Commits、账号 `lookfree`、不加 Co-Authored-By）。原型视觉尽量复用，别重做。
