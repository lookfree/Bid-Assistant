# Code-review 跟踪（未修复项）

记录各 spec code-review 中**已确认、但本轮未修**的发现，便于后续按计划补上。状态：`deferred`（待修）/ `wontfix`（有意不修，附理由）。

## spec004 · 手机号验证码鉴权（review 于 2026-06）

本轮只修了 correctness #1–#5（手机号归一化、限流/冷却原子化、发送失败回滚、并发首登竞态、协议判定先于消费码）。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| 6 | `routes/auth.ts` `clientIp` | `X-Forwarded-For` 取最左值且无可信代理校验，客户端可伪造 → **per-IP 限流可绕过** | 中（被 `SMS_IP_LIMIT_ENABLED` 默认关闭缓解） | deferred | 加 `TRUST_PROXY_HOPS` 配置，按受信跳数取 XFF 的客户端 IP；hops=0 时不信任 XFF。落地与部署（Nginx/Ingress）一并定。 |
| 7 | `services/auth.ts` `resolveUserFromToken` | 每次鉴权串行两查（`findValidSession` + `getUserById`），热路径双倍远程 DB 往返 | 低（效率） | deferred | 加 `findUserByValidSessionToken(tokenHash)`（sessions⋈users 一次 join）；`logout` 也可改单条 UPDATE。 |
| 8 | `test/routes/auth.test.ts`、`test/services/sms-code.test.ts` | 未复用 `test/repos/helpers.ts` 的 `uniquePhone` / `TEST_TIMEOUT_MS` / `deleteTestUser`，各自内联 | 低（清理） | deferred | import 复用 helpers；魔法数/生成器集中一处。 |
| 9 | `services/captcha.ts` | `CAPTCHA_ENABLED` 默认开，但能启动时恒走 DevPass（放行），配真实凭据反而启动即抛 → 滑块当前是“有意的空操作” | 低（有意延迟） | wontfix（spec004.1） | 真实滑块校验器（`@alicloud/captcha20230305`）+ 前端组件在 **spec004.1** 接入（待阿里云验证码凭据就绪）。已 `console.warn` 提示。 |
| — | `services/sms-code.ts` `verify` | `GET`→比较→`DEL` 非原子，并发同码两次校验可能都返回 true（多签发一个会话） | 低（影响良性；#1 catch 后不再造成 500） | deferred | 用一段 Lua 原子化 `GET+比较+DEL+尝试计数`（注意 ioredis keyPrefix 对 eval KEYS 的处理）。 |
| 10 | `services/sms-code.ts` `SmsLimits` | 11 字段扁平类型在 env/index 映射/类型/测试 4 处重述 | 低（简化） | deferred | 直接传 `env` 或按 concern 分组（`cooldown?`/`phone?`/`ip?`/`attempts?`，子对象存在即启用），消除 4 个 `*Enabled` 布尔。 |

## spec005 · 前端接入登录（review 于 2026-07）

本轮修了 correctness #1–#6（400 按 error code 分支、403 captcha 文案、守卫带 redirect 回跳、CORS 用数组白名单、401 自愈复位登录态、localStorage 隐私模式退内存）。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| 7 | `components/auth/require-auth.tsx`、`app/(tool)/layout.tsx` | 鉴权是**客户端-only**:受保护页会先挂载、子 effect 可能在 `/auth/me` 返回并 `router.replace` 之前触发;未登录访客还会整棵渲染 sidebar/nav/paywall 再跳。非请求边界的安全门。 | 中（altitude） | deferred | `middleware.ts` 服务端 gate `(tool)/*`(登录前就拦、不下发受保护代码），配 cookie 会话——正好衔接 spec 里 deferred 的 **BFF httpOnly** 方案;RequireAuth 降级为 UX 兜底。 |
| — | `lib/api.ts` vs `config/env.ts` | 前端 `NEXT_PUBLIC_CAPTCHA_ENABLED`(默认 false）与后端 `CAPTCHA_ENABLED`(默认 true）**默认值相反**,现靠 dev DevPass 掩盖,真滑块一接即 403。 | 中（配置耦合） | deferred（spec004.1） | 接真实滑块时对齐两侧开关(同一来源/部署校验),前端收集真实 token,不再发 `""`。 |

> #8（合并两个 `return null`）、#9（抽 `memoryStorage()` 供兜底+测试复用）已在 /simplify 一轮修掉。
> 修复时把对应行从表里移走或标 `done`。
