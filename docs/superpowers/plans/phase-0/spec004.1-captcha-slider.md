# spec004.1 · 滑块人机验证（阿里云验证码2.0）补全 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 spec004 里留的滑块人机验证缺口——用户点「获取验证码」时先弹阿里云验证码2.0 的拼图滑块，拖动通过才发短信，拦短信轰炸/接口刷量。后端补上 spec004 里"尚未接入"的真实校验器（`@alicloud/captcha20230305 VerifyIntelligentCaptcha`），前端补上滑块 SDK 接入。**契约不变**（`POST /auth/sms/send` 仍收 `captchaToken?`、失败仍 `403 captcha_required`、`verify(token?)→bool` 接口不变），本轮只把两个"尚未接入"的空档填实。

**Architecture:** 后端 `services/captcha.ts` 的三态工厂「有凭据」分支从"抛错占位"改为返回真实 `AliyunCaptchaVerifier`——它把前端产出的 `captchaVerifyParam`（即 `verify(token)` 的 `token`）经 `@alicloud/captcha20230305` 的 `VerifyIntelligentCaptcha({ SceneId, CaptchaVerifyParam })` 送阿里云校验，`body.Result.VerifyResult` 为真才放行；阿里云 API 本身报错（网络/鉴权）→ **fail-closed 返回 false**（宁可让用户重滑，绝不因基建抖动放过机器人）。校验器的阿里云 client 依赖注入，单测用 fake client 覆盖 通过/拒绝/API异常 三态，不打真实阿里云。前端登录页在 `captchaEnabled` 为真时惰性加载阿里云 captcha JS SDK，把「获取验证码」按钮托管给 SDK：SDK 弹拼图 → 用户拖动 → `captchaVerifyCallback(captchaVerifyParam)` 里调 `sendSmsCode(phone, captchaVerifyParam)` → 200 则返回 `{ captchaResult: true }` 让 SDK 收起、否则 `false` 让用户重滑。滑块关闭（`captchaEnabled=false`）时不加载 SDK、直接发码，行为与今天完全一致。

**Tech Stack:** App API（Hono + `@alicloud/captcha20230305` + `@alicloud/openapi-client`，纯 JS，DI 便于单测，`bun:test`）；Web（Next.js，动态 `<script>` 注入阿里云 captcha SDK，无 npm 包）；配置（env）。

## Global Constraints

- **契约冻结**：`POST /auth/sms/send` body `{ phone, captchaToken? }`、`403 { error:"captcha_required" }`、`CaptchaVerifier.verify(token?)→Promise<boolean>`、`createCaptchaVerifier(env)` 工厂签名——全部不动，本轮只填「有凭据」分支的实现。auth 路由层（`routes/auth.ts` 的 `captchaEnabled && !verifyCaptcha`）一行不改。
- **fail-closed 铁律**：① 无凭据 + 生产 + 已开启 → 工厂抛错（既有行为，保留）；② 有凭据但阿里云 API 调用异常/超时 → `verify` 返回 `false`（不放行）；③ 前端 SDK 加载失败且滑块开启 → 不发码、提示"验证组件加载失败，请刷新重试"（不静默跳过滑块）。人机验证只在"确定通过"时放行。
- **关闭态零变化**：`CAPTCHA_ENABLED=false`（后端）/ `NEXT_PUBLIC_CAPTCHA_ENABLED=false`（前端，mbp 当前值）→ 后端 DevPass 恒放行、前端不加载 SDK 直接发码，与今天逐字节一致。滑块是"配齐凭据即生效"的增量，默认部署不受影响。
- **前端 SceneId/prefix 是公开值**：阿里云验证码2.0 的 `SceneId`、`prefix`（身份标）本就出现在浏览器端，走 `NEXT_PUBLIC_*`，不算敏感；`ALIYUN_CAPTCHA_ACCESS_KEY_*` 是敏感后端凭据，只在 `.env.bidsaas.local`。
- **money-blind 无关**：本轮不碰计费。
- **不新增外部 npm 到前端**：阿里云 captcha 前端 SDK 用官方 CDN 脚本（`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`）动态注入，不进 package.json（官方分发方式，且便于 CSP 白名单单点管理）。
- 提交英文 Conventional Commits、作者 lookfree <etwuman@126.com>、无任何 Claude 相关内容/Co-Authored-By；函数 ≤80 行、文件 ≤800 行；关键方法注释解释"为什么"。
- 集成/单测：`apps/api` 走 `./test-on-mbp.sh`（连真库/真 Redis，captcha 校验器单测全 mock 阿里云，不打真实计费/风控接口）；前端 `pnpm lint` + 逻辑单测（SDK 全 mock）。

## 契约

### 现状代码（本轮要动/依赖的位置）
- `apps/api/src/services/captcha.ts`：三态工厂，「有凭据」分支（L25-29）现在抛错——**本轮改为返回 `AliyunCaptchaVerifier`**；`DevPassCaptchaVerifier`、无凭据两分支不变。
- `apps/api/src/config/env.ts`：L51-54 已有 `CAPTCHA_ENABLED`（默认 true）、`ALIYUN_CAPTCHA_ACCESS_KEY_ID/SECRET/SCENE_ID`——**新增 `ALIYUN_CAPTCHA_ENDPOINT`**（默认 `captcha.cn-shanghai.aliyuncs.com`；验证码2.0 仅上海/新加坡有 region）。
- `apps/api/src/routes/auth.ts`：L35-36 校验逻辑**不改**；`sendSchema` 的 `captchaToken` 加一个宽松长度上限（`captchaVerifyParam` 是 JSON 串，几百字节；`.max(4096)` 防超大 body 滥用）。
- `apps/api/src/index.ts` L35 `createCaptchaVerifier(env)`、`app.ts` 注入——**不改**（工厂内部实现变化对调用方透明）。
- `apps/web/app/login/page.tsx`：`handleSendCode`（L47-57）现在开启时塞占位 `""`——**本轮改为开启时走 SDK 拿真 param**；「获取验证码」按钮（L191-197）托管给 SDK。
- `apps/web/lib/api-client.ts` L42-43 `sendSmsCode(phone, captchaToken?)`——**不改**。
- `apps/web/lib/api.ts` L21 `captchaEnabled = NEXT_PUBLIC_CAPTCHA_ENABLED === "true"`——**不改**；新增读取 `NEXT_PUBLIC_CAPTCHA_SCENE_ID`、`NEXT_PUBLIC_CAPTCHA_PREFIX`。
- `apps/api/package.json`：依赖只有 `@alicloud/dysmsapi20170525`+`@alicloud/openapi-client`——**新增 `@alicloud/captcha20230305`**。

### 后端：`AliyunCaptchaVerifier`（新，captcha.ts 内）
```ts
// client 依赖注入（单测传 fake）；生产由工厂用 openapi Config 构造真 client。
export class AliyunCaptchaVerifier implements CaptchaVerifier {
  constructor(private client: { verifyIntelligentCaptcha(req): Promise<VerifyResp> },
              private sceneId: string) {}
  async verify(token?: string): Promise<boolean> {
    if (!token) return false                     // 无 param 直接判负（开启滑块却没滑）
    try {
      const resp = await this.client.verifyIntelligentCaptcha(
        new VerifyIntelligentCaptchaRequest({ sceneId: this.sceneId, captchaVerifyParam: token }))
      // 阿里云：Success=API 调用成功；Result.VerifyResult=人机校验结论。两者皆真才放行。
      return resp?.body?.result?.verifyResult === true
    } catch {
      return false                               // fail-closed：网络/鉴权异常绝不放行
    }
  }
}
```
- 工厂「有凭据」分支：用 `@alicloud/openapi-client` 的 `Config({ accessKeyId, accessKeySecret, endpoint: env.ALIYUN_CAPTCHA_ENDPOINT })` 造 `Client`，包一个 `{ verifyIntelligentCaptcha }` 适配对象注入 `AliyunCaptchaVerifier`（适配层便于单测替身，且隔离 SDK 具体形态）。
- 三态其余不变：无凭据+生产+开启→抛（保留）；无凭据+非生产→DevPass（保留）。

### 前端：滑块接入（login/page.tsx + 小 helper）
1. 新 helper `apps/web/lib/captcha.ts`：`loadAliyunCaptcha(): Promise<AliyunCaptchaGlobal>`——惰性注入 CDN `<script>`（只注一次，缓存 Promise），resolve 出 `window.initAliyunCaptcha`；加载失败 reject。`initCaptcha({ sceneId, prefix, buttonEl, onVerify })` 薄封装 `initAliyunCaptcha`（popup 模式、中文、拼图样式），把 SDK 的 `captchaVerifyCallback(param)` 桥接到我们的 `onVerify(param): Promise<boolean>` 并按约定返回 `{ captchaResult }`。
2. `login/page.tsx`：
   - `captchaEnabled` 为真时，`useEffect` 里 `loadAliyunCaptcha().then(initCaptcha(...))`，把「获取验证码」按钮注册为 SDK 触发按钮；`onVerify = async (param) => { try { await sendSmsCode(phone, param); startCountdown(); return true } catch { return false } }`（true 收起滑块、false 让用户重滑）。加载失败 → 置错误态，按钮点击提示"验证组件加载失败，请刷新重试"，**不发码**。
   - `captchaEnabled` 为假时：`handleSendCode` 保持今天逻辑（直接 `sendSmsCode(phone, undefined)`），不加载 SDK。
   - 号码非法/倒计时中：按钮 `disabled`（既有 `canSend`），SDK 不弹（滑块只在能发码时可触发）。
3. `apps/web/lib/api.ts`：导出 `captchaSceneId = process.env.NEXT_PUBLIC_CAPTCHA_SCENE_ID ?? ""`、`captchaPrefix = process.env.NEXT_PUBLIC_CAPTCHA_PREFIX ?? ""`。
4. `apps/web/Dockerfile` + `.env.local` + `deploy` env 模板：加 `NEXT_PUBLIC_CAPTCHA_SCENE_ID`、`NEXT_PUBLIC_CAPTCHA_PREFIX`（构建期注入，同 `NEXT_PUBLIC_CAPTCHA_ENABLED` 既有姿势）。

### 配置（env）
- 后端 `.env.bidsaas.example` 补 `ALIYUN_CAPTCHA_ENDPOINT=`（注释：默认 captcha.cn-shanghai.aliyuncs.com）；`ALIYUN_CAPTCHA_ACCESS_KEY_ID/SECRET/SCENE_ID` 已在（spec004 加过），补注释"复用短信 AK 需授 AliyunYundunCaptchaFullAccess"。
- 前端 `.env.local`/`Dockerfile` 补 `NEXT_PUBLIC_CAPTCHA_SCENE_ID=`、`NEXT_PUBLIC_CAPTCHA_PREFIX=`。
- **交付默认全空/关闭**——mbp 部署行为不变；用户配齐 4 个真值（SceneId、prefix、AK id/secret，或复用短信 AK）+ 翻 `CAPTCHA_ENABLED`/`NEXT_PUBLIC_CAPTCHA_ENABLED=true` 即生效。

### 验证口径
- 后端 `bun test`（mbp）：`AliyunCaptchaVerifier` 三态——① fake client 返回 `verifyResult:true`→`verify` 得 true；② 返回 `false`/结构缺失→false；③ client 抛异常→false（fail-closed）；④ `token` 为空/undefined→false 且不调 client。工厂：有凭据分支返回 `AliyunCaptchaVerifier` 实例（不再抛）；无凭据两分支行为不变（回归）。auth 路由既有 captcha 测试（开启+校验不过→403）**保持绿**，证明契约没破。
- 前端逻辑单测（SDK 全 mock）：`onVerify` 成功路径返回 true 且触发倒计时；`sendSmsCode` 抛错时返回 false 且不倒计时；`captchaEnabled=false` 时 `handleSendCode` 不加载 SDK 直接发码。`loadAliyunCaptcha` 只注入一次 `<script>`（重复调用复用缓存 Promise）。
- 端到端（配齐凭据后手测，mbp）：登录页点「获取验证码」→ 弹阿里云拼图 → 拖动通过 → 收到短信；乱拖/不拖 → 不发码。

## Tasks

- [x] **Task A（后端校验器）**：加 `@alicloud/captcha20230305` 依赖 + `ALIYUN_CAPTCHA_ENDPOINT` env + `AliyunCaptchaVerifier`（DI client）+ 工厂有凭据分支返回它 + 三态单测（mock 阿里云）+ auth 既有 captcha 测试保绿。
- [x] **Task B（前端滑块）**：`lib/captcha.ts` SDK 加载/初始化 helper + `login/page.tsx` 接入（开启走 SDK、关闭原样、加载失败 fail-closed）+ `NEXT_PUBLIC_CAPTCHA_SCENE_ID/PREFIX` 贯穿 env/Dockerfile + 逻辑单测（SDK mock）。
- [x] **Task C（验证/部署）**：`bun test`（mbp）+ `pnpm lint` 全绿 → `/code-review` 全修 → 合并 main → 部署 mbp（滑块 OFF，验证登录行为与今天一致）。
- [ ] **Task D（人工+接真）**：用户在阿里云控制台建验证码2.0 场景 → 提供 SceneId/prefix/AK（或复用短信 AK 并授权）→ 配 env + 翻开关 → 端到端验收"拖动通过才发码"。

## 决策记录

1. **复用现有三态工厂契约，不重构**：`createCaptchaVerifier`/`CaptchaVerifier.verify(token)`/auth 路由钩子在 spec004 就设计成"实现可替换"，本轮只把「有凭据」分支从抛错换成真实现——auth 路由、app/index 注入、前端 `sendSmsCode` 签名全不动，改动面最小，契约测试即回归护栏。
2. **阿里云 API 异常 fail-closed（返回 false 而非放行）**：人机验证的意义就是拦机器人，基建抖动时"放过"等于给刷量开后门；宁可让真人偶尔重滑一次。与工厂"无凭据+生产"的 fail-closed 抛错同一姿态。
3. **前端用 CDN 脚本而非 npm 包**：阿里云 captcha2.0 前端只官方分发 CDN JS（`o.alicdn.com`），无维护良好的 npm 包；动态注入 + 缓存 Promise 只注一次，且 CSP 白名单单点加一个 `o.alicdn.com` 即可，比打进 bundle 更透明。
4. **SceneId/prefix 走 `NEXT_PUBLIC_*`**：它们本就渲染进浏览器供 SDK 初始化，非秘密；真正的秘密是后端 AK。前后端配置分层与既有 `NEXT_PUBLIC_CAPTCHA_ENABLED` 一致。
5. **mock-first、凭据后置**：校验器单测全 mock 阿里云，前端 SDK 逻辑 mock——实现与部署（滑块 OFF）不依赖任何外部凭据先行落地；用户建场景给凭据后翻开关即接真，不阻塞本轮开发。
6. **不做行为验证码/无感验证/二次风控联动**：本轮只做"拖拽拼图"这一种阿里云 2.0 内置形态（对应用户参考的 Seko 样式）；无感/滑动+点选混合、结合登录风险分动态决定是否弹——留候选，等真实刷量数据再说。

## 本轮不做（候选池）
- 阿里云验证码"无感模式"/风险分驱动的动态弹出。
- 滑块拦截扩展到 wechat 登录、其它写接口（本轮只 `/auth/sms/send`）。
- 前端 captcha 组件的可视化 E2E（Playwright 真拖）；本轮靠 mock 逻辑单测 + 人工端到端。
