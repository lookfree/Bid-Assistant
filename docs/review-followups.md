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

## spec004.2 · 微信扫码登录（review 于 2026-07）

本轮修了 correctness #1–#5（回调页 ref 守卫只换一次、微信首登补 `IdentityAlreadyBoundError` 竞态、state 改 `getdel` 原子消费、401 仅带令牌才触发 `onUnauthorized`、WxLogin 渲染前清容器）。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| A2 | `services/wechat-auth.ts` | `identifier = unionid ?? openid` 跨次可能不稳:token 无 unionid 且 userinfo 失败时以 openid 建号,日后拿到 unionid 会 miss → 建**重复账号** | 中（真实凭据期） | deferred（凭据就绪） | 开放平台绑定使 unionid 恒有;或首登同时 `addIdentity` 落 openid+unionid 两身份,任一命中即同一人。 |
| A3 | `services/wechat-auth.ts` | `getdel` 在换码前消费 state,换码瞬时失败会烧掉 state（需重扫） | 低 | wontfix | CSRF state 本就一次性,失败重扫即可;若要可重试,改为换码成功后再消费（放开 replay 窗口需权衡）。 |

> R1（会话签发重复）、R2（找/建+竞态重复）、S1（`getJson<T>` 抽取）、Alt3（`lib/wechat-login.ts` typed wrapper）已在 /simplify 一轮修掉:抽 `createOrGetOnConflict`（repos/users）+ `mintSession`（auth）供 phone/wechat 共用,竞态与会话逻辑各归一处。

## spec006 · 文件直传（review 于 2026-07）

本轮"全修"修了 correctness #1–#3 + 复用 R1/R2/R3（confirmUpload 复验真实大小、headObject 只对 404 返 null、Content-Disposition RFC 5987、`closeS3()` 接 SIGINT、文件错误改类型化 + 路由 `instanceof`）。以下属需后台/基建层，超出代码修范围,记录待做：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| Alt3 | `services/files.ts` `presignUpload` | `pending` 行建了但客户端不调 `/complete`（关页/失败/刷 presign）就**永久堆积**;无 reaper/cron/MinIO lifecycle | 中（运维） | deferred | MinIO 对 `uploads/` 前缀设 lifecycle 过期规则（清对象）+ 定期 reaper 删超 presign TTL 的 `pending` 行；等 Phase 后台任务层落地。 |
| A1深 | `storage/s3.ts` `presignPut` | 大小上限现为"确认时复验后删"（detection-after-the-fact），非入口拦截 | 低 | deferred | 用预签名 **POST + `content-length-range` 策略**让 MinIO 入口就拒超大 body（prevention），替代先存后删。 |

> 说明:oversize 复验的集成测试需 >50MB 上传或改 env 缓存,成本过高暂缺;修复已由 typecheck + 正常路径用例覆盖。
> 修复时把对应行从表里移走或标 `done`。

## spec102 · 观测与埋点（review 于 2026-07）

全修了 correctness #1–#3（falsy-empty payload 存 NULL、start_run resume 冲掉 started_at、record_usage None provider/model 丢用量）+ SE1（`_exec` 助手去重）+ SE2（finish_run 单次聚合扫描）。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| seq | `telemetry/schema.py` `agent_event_log` | `seq=max+1` 无 `unique(run_id,seq)`；并发/异步流式回调/重试写同 run 会产生重复 seq | 低 | deferred | 由"单 worker 串行写"设计兜底（代码注释已声明）。加 `UNIQUE(run_id,seq)` 需在幂等 DDL 里替换既有非唯一索引（drop+create unique），等 spec104 运行时确定单/多 worker 写入模型后再定；届时若并发写则改用 run 级 DB sequence。 |
| FK | `telemetry/schema.py` 子表 | 子表 `run_id` 无外键到 `agent_request`，可孤儿 | 低 | wontfix | 埋点有意 best-effort：加 FK 会因写入顺序/start_run 失败而硬丢事件，与"尽量记全"目标相悖。 |

## spec103 · 模型网关（review 于 2026-07）

只修了 correctness #1（埋点写在守护 LLM 的 try 内 → 埋点失败触发重复计费的故障转移 + 丢已成功响应；改成 best-effort）、#2（record_usage 的 agent_type NOT NULL 无兜底；改 `agent_type or 'unknown'`）。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| A3 | `models/gateway.py` `get_chat`/`_chain` | 回退链里 provider 拼错（如 `qwem:...`）→ `PROVIDERS[x]` 抛裸 KeyError，被故障转移当普通 `model.error` 吞掉，配置错永久静默、拼错的回退永不生效 | 低 | deferred | `get_chat`/`_chain` 里 provider 不在 `PROVIDERS` 时抛清晰 `ValueError("unknown provider ...")`，或在 `_chain` 构建时校验并对未知 provider 记一条可辨认的 warn；等 spec104 接线时定。 |

## spec104 · Run 运行时（review 于 2026-07）

修了 correctness #1–#4：#1 **进度通道 pub/sub → 每 run 一条 Redis Stream**（晚订阅/断线重连可从头回放，SSE 订阅已结束 run 不再永挂）、#2 SSE 阻塞 XREAD 丢 `asyncio.to_thread`（不卡事件循环）、#3 process_run 缺 runmeta 即标 failed（不再 NOT NULL 孤儿）、#4 finish_run 先于落 result。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| A3 | `runtime/dispatch.py` `create_run` | DB insert(queued)→SET→XADD 三步非原子；进程在 commit 后、XADD 前崩溃 → run 永 queued 且无入队，无对账 | 中 | deferred | spec107 加固：事务化 outbox（DB 记待派发、后台补投）或定期 reaper 扫描超时 `queued` 行重新入队/标失败。 |
| A5 | `main_worker.py` `run_loop` | `XREAD $` 只读新消息 + 无 XACK：worker 停机期间入队的 run 永不消费；崩溃中的 in-flight run 无 redelivery | 中 | deferred | spec107：改 **consumer group（XREADGROUP + XACK）**，宕机不丢、可水平扩（§4.6 竞争消费）；spec 已声明本 spec 先简化。 |
| A7 | `checkpointer.py` `get_checkpointer` | `_saver` 单例绑定首个事件循环，跨 `asyncio.run()`（不同 loop）复用会 "attached to a different loop"；`_cm` 从不 `__aexit__`（进程级常驻，非泄漏但无优雅关闭） | 中 | deferred | spec106 真实图在 worker 单事件循环下会真正用到 checkpointer——届时验证单循环下 OK；若多循环场景需按 loop 建 saver 或用 `async with` 生命周期管理。 |
| tok | `routes/runs.py` `GET /runs/{id}` | dummy run 的 tokens 恒 0（dummy 不调 record_usage） | 低 | wontfix | 有意：dummy 是管线夹具；真 agent（spec107 读标经 ModelGateway）才记 usage，届时非 0。 |

## spec105 · 智能体编写框架（实现于 2026-07）

实现了 Hook/Backend/resilient/结构化输出/HITL/压缩/BaseAgent/DeepAgent 八原语。以下按 spec 列出但**本 spec 未实现**：

| # | 文件 | 说明 | 状态 | 何时做 |
|---|---|---|---|---|
| create_agent | `framework/create_agent.py` `build_create_agent(prompt,tools,ctx)` | File Structure/Interfaces 列了它（可 ainvoke 的确定性子图，不带 checkpointer），但 spec 只给了 base_agent.py 代码、未给它的实现，验收清单也不含；**Phase 1 的 106/107/108 都不用它**，它是 Phase 2 工作流节点（spec202/204/205 提纲/审查/述标）的依赖 | deferred | Phase 2 spec202 真正需要时实现 + 测试 |

> 另：spec 里 `create_deep_agent(instructions=...)` 在装到的 deepagents 0.6.12 已改名 `system_prompt=`；`resilient_tool_node` 未用 langgraph `ToolNode`（该版 ToolNode 需图运行时注入、无法脱图单测），改为自执行 tool_calls。
