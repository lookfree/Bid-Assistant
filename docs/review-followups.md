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

## spec105 · code-review（review 于 2026-07）

全修了 correctness #1–#5：#1 astream 只流 AIMessage（工具消息不当 agent 文本吐前端）、#2 agent_node 用量埋点抽 `record_llm_usage` 共享助手且 best-effort（与 gateway.invoke 复用，DB 抖动不拖垮已成功一轮）、#3 aresume 与 astream 共用 `_decode_stream`（resume 段有 node.end/result + 二次 interrupt）、#4 compressor `gateway.invoke` 丢 `asyncio.to_thread`、#5 checkpointer 换 loop 前 best-effort 关旧 `_cm`。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 建议修法 |
|---|---|---|---|---|---|
| C1 | `framework/deepagent.py` | DeepAgent 覆盖 `_compile` 走 deepagents 自己的图、绕过 agent_node → **不记 token 用量**（settle 汇总 0） | 中 | deferred | Phase 2 spec203 deep agent 真跑时：在其 astream 流上聚合各节点 AIMessage 的 usage_metadata，run 末调一次 record_usage。需先真跑 deepagents 看事件形状（现有 DeepSeek key 可做）。 |
| C2 | `framework/base_agent.py` `_decode_stream` | messages chunk 的 node 硬编码 `"agent"`，解不了 deepagents 多节点/子智能体图 | 低 | deferred | 用 `meta.langgraph_node` 取真实节点名；随 C1 一起在 deep agent 真跑时定。 |
| C4 | `framework/base_agent.py` `_decode_stream` | 只发 node.end、不发 node.start（观测缺一半，executor 容忍不崩） | 低 | deferred | langgraph updates 是节点完成后才产出，补 node.start 需换驱动方式（debug 流或首见推断）；观测增强，Phase 2 视需要。 |

> 另：resilient_tool_node 未用 langgraph ToolNode（该版需图运行时注入、无法脱图单测）；create_agent.py/build_create_agent 仍 defer Phase 2（见上一条 spec105 条目）。

## spec106+107 · code-review（review 于 2026-07，5 个只读 Explore 角度）

全修了 correctness：#1 parse_document 内联条款 id（模型可产出真实 clause_ids）、#2 minio_endpoint 缺失即报错（不静默回退 AWS）、#3 BiddingAgent.astream 总发 read node.end（模型没 submit 也发 result=None，避免假成功）。+ parsers docstrings + parsing 测试生成器抽 conftest docgen fixture。以下未修：

| # | 文件 | 问题 | 严重度 | 状态 | 何时做 |
|---|---|---|---|---|---|
| RA2 | `framework/base_agent.py` + `bidding_agent/agent.py` | BiddingAgent.astream 靠"丢 node.end 再重发结构化结果"这个 workaround；更干净是给 `AgentBuild` 加 `result_extractor` 回调，BaseAgent 统一处理 | 低 | deferred | Phase 2 装配多节点工作流图时一并重构（对外契约不变） |
| C1 | `bidding_agent/agent.py` | node.end 丢弃使 executor 的 node_count 只计到 agent/read，中间 tools 节点没计入（观测偏低，不影响结果） | 低 | deferred | 与 spec105 C4（node.start 缺失）一起在 Phase 2 增强观测 |

## spec108 · Task 4 web /read 接真实接口（发现架构缺口，2026-07）

后端里程碑（Tasks 1–3 + 真 2-服务 e2e）已完成合并。web `/read` 页接真实接口时发现缺口，未做：

| # | 位置 | 问题 | 状态 | 建议 |
|---|---|---|---|---|
| doc | `/api/read` 返回 vs `read/page.tsx` | 页面核心交互（点解读→右栏高亮招标原文条款）依赖**静态 tenderDoc 全文 + 匹配 clause_ids**；`/api/read` 只返回 ReadResult（六大分类/评分/风险），**不含解析后的全文/clauses**。真数据接入后：类目/评分/风险可渲染，但右栏原文 + clauseLocation 定位会断（真 doc 的 sec-1-c1 在静态 doc 里无匹配）；且 `categories[].icon`（Lucide 组件）agent 不返回、需按 key 合并 | deferred | 先给后端补：`/api/read` 结果或 agent_runs 落库时**一并存解析后的 clauses**（parse_document 已产出 ParsedDoc.clauses），供前端右栏渲染原文 + 定位；前端再：按 category key 合并 icon、categories/scoring/risks 用真数据、clauseLocation 用真 clauses。然后浏览器验一遍。属 Phase 2 全流程接入（spec207）的一部分。 |

## spec201 · code-review（review 于 2026-07，8 角度 Explore + 自验）

全修了 ①–⑥：① executor 处理 step.done（落 event_log + 取 result，修「工作流 run 结果丢失、假成功」）；② DeepAgent._compile 迁到 1 参 `(ctx)` 走 ctx.checkpointer（原 2 参签名会在 astream 里 TypeError）；③+⑦ BiddingAgent.astream 靠流事件记「实际跑过的节点」再发 step.done（空产物如 read={} 不再被当成没跑、假成功），删 `_last_done_node` 真值推断；④ 抽 `make_agent_node` 供 base 单循环与 build_create_agent 共用（去重 agent_node+埋点）；⑥ 删 BiddingState 死字段 `step`/`messages`。以下未修：

| # | 位置 | 问题 | 严重度 | 状态 | 何时做 |
|---|---|---|---|---|---|
| A5(altitude) | `bidding_agent/agent.py` | 工作流式 astream（seed-vs-resume + 记录 ran_node + step.done + `_RESULT_KEY`）是任意「interrupt 工作流 agent」通用逻辑，现落在 bidding 专有类；第二个图 agent（contract_review）会复制粘贴 | 中 | deferred | **YAGNI**：当前仅 1 个图 agent，此时上提到 BaseAgent 属投机抽象（CLAUDE.md「不做投机性设计」）。待 contract_review 落地、有第二处复用时，再把通用部分上提 BaseAgent（`_RESULT_KEY` 作子类钩子/类属性）。 |

## spec202 · code-review（review 于 2026-07，8 角度 Explore + 自验）

全修：M1 「模型没 submit → 静默空结果假成功」——新增 `framework/create_agent.run_submit_agent`（未提交/校验失败即抛错 → run failed，checkpoint 停节点前可重试），read/outline 节点统一走它（read 原 `{}`、outline 原 `{"chapters": []}` 的发散 fallback 一并消除）；M2 三份 submit-then-done 测试 fake 去重为 `tests/agents/bidding_agent/conftest.py::SubmitChat/SubmitGateway`；M3 outline 提示词裁掉 `source_quote`（token 大头）；M4 强化 schema 捕获断言为原样往返 + 补「未提交即失败」契约测试。以下未修/驳回：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| S1 | `apps/api`（spec207） | agent 产出 snake_case（clause_ids/is_new），前端原型用 camelCase；App 层 toCamel 桥尚未实现 | deferred | 属 spec207 App 编排（已有 spec108 web 缺口条目，桥一并做） |
| S2 | `schemas.py` OutlineChapter | review 提出缺 `body/demoBody`（对齐 TS BidChapter） | refuted | 设计即分离：正文在 `state['chapters']`（spec203），`demoBody` 是原型演示填充，不属 agent 契约 |
| S3 | `framework/structured.py` | double-submit 后写覆盖前写（last-write-wins） | deferred | 提示词已约束"一次性提交"；如真实跑发现多次提交，再加首写胜/计数告警 |

## spec203 · code-review（review 于 2026-07，8 角度 Explore + 自验）

全修①–④ + 删孤儿⑤：① `_collect_chapters` content 改 `.get`（deepagents 自身按可缺处理）+ 跳过空稿（全空仍 fail-loud）；② 抽 `record_ctx_usage` 统一 make_agent_node 与 UsageCallback 两条埋点路径；③ `on_llm_end` 补 docstring + `LLMResult` 类型；④ `rewrite_chapter` docstring 注明 state 传 `snapshot.values`（spec207 契约）；⑤ 删 spec105 遗留孤儿 `framework/deepagent.py`（DeepAgent/DeepBuild）与 `framework/backend.py`（InStateBackend/create_backend_tools）及其测试——spec203 定案用 deepagents 内建（StateBackend 虚拟 FS + summarization middleware），`compressor.py` 保留（`AgentBuild.compressor` 钩子在用）。以下跳过留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| C1 | `nodes/content.py` `_collect_chapters` | 模型写嵌套路径（chapters/t1/x.html）会产生含 `/` 的 cid，与 outline 章 id 对不上 | deferred | 收稿宽容优于丢稿重试（重试烧真钱）；App 端按 outline id 匹配、多余 key 可忽略。真实运行观察到再收紧 |
| C2 | `nodes/content.py` | content 提示词保留 `source_quote`（outline 已裁） | wontfix | 子写手需原文证据写「可核查」正文；质量优先于 token，content 是质量关键节点 |
| C3 | `nodes/content.py` + `prompts/content.py` | `chapters/<id>.html` 约定在代码常量 + 两条提示词共三处 | deferred | 提示词字面量可读性优先；若约定变更需三处同改（grep `chapters/` 即全中） |

## spec204 · code-review（review 于 2026-07，4 合并角度 Explore + 自验）

全修：① schema 加固——`RiskFinding.level` 收 `Literal["高风险","中风险"]`（对齐原型取值）、`RiskReport.score` 加 0–100 界限、`high/mid/passed` 改 `@model_validator` 从 items/passed_items 推导（不信模型口头报数）；② `_slim_read` 上提为 `nodes/common.py::slim_read`，outline/review 共用（review 载荷裁 source_quote；chapters 保留全文——审查对象即正文）；③ 节点测试补 outline 键（贴近真实图态）。驳回：空串默认 vs TS 非可选（"" 合法）；outline 缺失防御（图序保证）；查重走提示词（计划 v1 即如此）。Altitude/Conventions 角度报告清洁。

## spec205 · code-review（review 于 2026-07，2 合并角度 Explore + 自验）

全修：① 模板色真正生效——`render_pptx` 用 `_TEMPLATE_RGB[template]` 给标题着色（原为死钩子，template 形参被静默忽略）；② `make_present_node` 的 duration 收敛到 {10,15,20}（对齐 DeckSpec Literal 档位）；③ present 载荷按计划「正文摘要」——`_plain` 剥 HTML 标签（token 减半）。驳回：同 key 覆盖（同 thread 重跑=最新版语义）；存储失败传播（fail-loud 设计）；run_submit_agent 替代计划旧草图（现行约定）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| P1 | `render/pptx.py` | `enterprise_template_id` 未实现（企业自有母版加载）；版式取 `slide_layouts[5]/[6]` 依赖默认模板索引 | deferred | 计划明确为加固项（"模板色/企业母版为加固项"）；接企业母版时一并改为按名找版式 |
| P2 | `render/pptx.py` | 封面/结束页 bullets 文本框定位可能与 title 位置重叠（通常这两类页无 bullets） | deferred | 视觉打磨项，真实 .pptx 冒烟已可打开；与 P1 一起做 |

## spec206 · code-review（review 于 2026-07，2 合并角度 Explore + 自验）

全修：① 表格列数取所有行最大值（原固定首行列数，模型产参差表格即 IndexError 崩渲染）；② `_emit_el` 递归展开容器标签（div/section 等，原被 get_text 压扁成单段丢结构）；③ 抽 `nodes/common.py::upload_artifact` 统一 present/export 的终产物落 MinIO 样板。补参差表格 + div 包裹回归测试。

## spec207 · 端到端里程碑（2026-07，真实 2 服务 × DeepSeek × MinIO 全链路）

上传招标 docx → read(6 类, 3 红线, 21s) → outline(12 章, 21s) → content(deepagent 12 章正文, 194s) → review(初次失败→重试成功, score 55/10 items) → present(14 slides+5 QA, 48s) → export(4s) → docx 90KB + pptx 68KB 预签名直下。每步独立 run + project_steps 记账（失败步 0 分不扣费）。e2e 逼出的三个真实修复：① worker 对远程 Redis 瞬断重试（原一次抖动即崩）；② 纯 submit 节点改 tool_choice 强制路径 + 校验错误喂回重试 ×3（模型自由发挥不调工具是高频真实失败模式，structured.py 注释本就预留此招）；③ 产物 key 解析对齐真实契约（export 步 result 即 artifacts 顶层快照；present 页下载 404 时先跑 export 再取）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| E1 | `/read` 页右栏 | 招标原文 + 条款定位仍用示例 doc（agent ReadResult 不含解析全文） | deferred | 需 agent 侧把 ParsedDoc.clauses 随 read 结果带出或另开查询口；接企业化需求时做（原 spec108 followup 收敛至此） |
| E2 | `rewrite_chapter` | 单章改写有 agent 函数无 App 路由（/content 右栏对话仍本地演示） | deferred | 需单独 run 类型或轻量同步端点；Phase 3 前补 |
| E3 | agent SSE step.done 的 artifacts 快照 | App 中继时未解析利用（现从 export 步 result 取） | wontfix-for-now | 现路径已闭环；若要 present 后立刻可下 pptx 不跑 export，再解析中继流 |

## spec207 · code-review（review 于 2026-07，3 合并角度 Explore + 自验）

全修：① 并发双击竞态——`project_steps` 加部分唯一索引 `(project_id, step) WHERE status='running'`，占位行先行、DB 层原子挡重（第二请求 409 step_already_running，不双建 run/双计费）；② SSE 中继异常收尾——relay/getRun/settle 全程 try/catch，中途炸标 failed（0 计费）+ 发 failed 事件，不留永久 running 卡死重试；createRun 失败同样释放占位；③ `toCamel` 仅递归纯对象（Date/Map 原样保留防丢值）；④ `_forced_submit` llm None 守卫 + 不走图循环的原因注释（强制 tool_choice 下图循环永不停机）。驳回：tool_choice 字符串形态（e2e 已实证）；SSE 多行 data（writeSSE 单行 JSON 契约）；use-step 竞态（页面级常量）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| A1 | `apps/web/app/(tool)/*/page.tsx` | content/present/risk 页 800+ 行（原型期预存量，spec207 只做手术式接线未拆） | deferred | 按 CLAUDE.md 拆分组件文件；商业化打磨期做 |
| A2 | 5 页 running/error 横幅 JSX 重复 | 同构横幅 ×4–5 处 | fixed-in-simplify | 抽 StepBanner 组件（见下一节 /simplify） |
| A3 | `routes/read.ts` | 与 projects 步进并存（计划明确 agent_runs 留给通用 run） | wontfix | 通用 run 记账路径，非死代码 |
| A4 | 上传多文件只取第一个已完成的建项目 | v1 单招标文件语义 | deferred | 多文件（附件/澄清函）归企业版需求 |

## spec301 · code-review（review 于 2026-07，2 合并角度 Explore + 自验，钱从严）

全修：① 汇率方向文档矛盾——spec301 计划 sketch（cny_cents_per_credit）与 spec304 公式（credits_per_cny_cent 正向）互斥，统一为 spec304 正向公式并在种子注明（汇率倒数=算错钱，最高危）；② `payment_orders`/`refunds` 加 `amount_cents > 0` CHECK（DB 层拒绝非正金额）；③ 幂等键改 notNull（nullable+unique 被多 NULL 绕过）；④ `refund_clawback` 补进权威规格文档类型清单（spec306 已用）；⑤ getConfigs LIKE 前缀转义；⑥ `updatedAt` 加 `$onUpdate`；⑦ 超长注释。补「负金额被拒/幂等键必填」测试。跳过：expectConflict 宽 catch（沿用既有测试模式）；seed 无事务（幂等可自愈）；drizzle 自动约束命名（与现表一致）。

## spec301 · /code-review 完整 8 角度（review 于 2026-07，钱从严·二轮）

在首轮修复（汇率方向/CHECK>0/幂等键 notNull/LIKE 转义/$onUpdate）之上，二轮全修：① 钱链路核心列加 **CHECK IN 枚举约束**（credit_transactions.type、payment_orders.type/status、refunds.status、subscriptions.status——typo 状态静默入库是真实对账破坏路径，表全新时加约束零成本）+ 非法枚举被拒测试；② `credit_tx_user_expire_idx (user_id, expire_at)` 复合索引（spec302 FIFO 消耗/spec306 过期扫描）；③ seedConfigs 批量单条插入；④ `expectConflict` 提取到 test/repos/helpers（三处重复收敛）；⑤ phase-3 计划草图 `import { db }` 与代码库 `getDb()` 契约错位——spec300 加实现注记，spec301 草图对齐加固后 schema；⑥ getConfig/getConfigs 函数注释。**实证驳回**：LIKE 缺 ESCAPE（真库验证：PG 默认转义符即反斜杠，转义命中真 key、拒绝假 key）；0006→0007 幂等键空窗（全新表、部署按序原子应用）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| L1 | spec305 | `subscriptions.current_period_end` 可空，状态机判断必须 null-guard | deferred | spec305 实现时的测试要点，已记入其验收语境 |
| L2 | `services/config.ts` | getConfig 每调一次 SELECT，spec302 每次操作查口径 | deferred | PK 查询开销极小且配置改动需即时生效；真实压测出现热点再加缓存（TTL/失效复杂度不白付） |
| L3 | `setConfig` | 值无 schema 校验（jsonb 任意） | deferred | spec310 运营后台是唯一写入口，届时按 key 加 zod 校验层 |
| L4 | 测试样板 | `loginWithPhone(...)` beforeAll 样板散布 7+ 文件 | deferred | 渐进收敛：新测试用 helpers，存量不批量翻动（Surgical） |

## spec302 · code-review（review 于 2026-07，钱从严——账本引擎）

抓到并修掉三个真实资损路径：① **settle+release 双返还**——结算成功后 SSE/推进阶段抛错，catch 补 settleFailed 导致一个 hold 同时有 settle(+差额) 和 release(+全额)。深修：了结行 ref=holdId + 部分唯一索引「每 hold 至多一条了结流水」(0010)，DB 层杜绝（含并发 settle+release 竞争）；双向回归测试。② **并发同幂等键 hold** 撞唯一约束抛错而非幂等返回——幂等检查移到用户行锁内（并发同键在锁上排队，第二个能看到第一个的行）；测试 5 并发同键全部拿同一 holdId。③ read.ts 流式体无 try/catch——中继中途炸 hold 永久冻结；补兜底退还 + run 标 failed。附带：hold 幂等命中校验流水类型（键跨类型复用即报错）；sumBalance/lockUserBalanceRow 提取（3x/2x 重复）；projects 步进收尾拆 finishStep（处理器回 80 行内）；makeLedgerUser 测试助手上提。驳回：FIFO 只在到期批次间分配消耗（"先过期先扣"语义即消耗优先抵扣先过期批次，非过期批次天然靠后）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| C1 | 孤儿 hold 清扫 | ~~进程被杀在 hold 与了结之间 → 冻结积分无人回收~~ | **done（spec306）** | releaseOrphanHolds：扫 >24h 无了结 hold 自动 release + orphan_hold 差异留痕；ledger-audit Cron 每日跑（不依赖支付凭据） |
| C2 | 用量→积分换算口径 | settle v1 按操作口径全额结算；agent_token_usage 真实用量换算待商业定价（如 token_credit_rate）定义 | deferred | 定价定稿后编排层改传真实用量即启用多退少补（机制已就绪并有测试） |

## spec303 · code-review（review 于 2026-07，Cron 调度器——billing job 的互斥地基）

8 角度全审（含 ioredis 5.11.1 实证：keyPrefix 对 eval 的 KEYS、set、pexpire 一致加 `bid:` 前缀，无键错位）。修复：① **锁 token 改每次抢锁一次性 UUID**——进程级 instanceId 作锁值时，jobFn 超 TTL 后同进程下一 tick 重抢（值相同），旧调用 finally 的 CAS 会误删新锁 → 第三实例趁虚而入并发跑 billing job（4 角度交叉命中）；instanceId 保留作日志。② **watchdog 续租改 Lua CAS**（get==token 才 PEXPIRE）——裸 PEXPIRE 在锁易主后会给别人的锁无限续命：他人崩溃时「TTL 自愈」失效，接管被阻塞至本实例长任务结束；发现易主（返回 0）即停止续租并告警。③ **finally 释放锁包 try/catch**——释放 eval 拒绝（如停机时连接已断）会替换 fn 的结果/原始异常，成功的 job 被报成失败；释放失败只记日志，锁靠 TTL 自愈。④ **注册时立即首跑 tick**——天级 everyMs（spec304 签到/spec306 对账、过期均按日）遇上重启比周期频繁，setInterval 永远等不到首个到点 → 每日对账/积分过期静默停摆；首跑重复触发由锁+业务幂等键去重。⑤ tick 在途守卫（上一 tick 未完跳过，不空耗 SET）+ **stop()/stopAll() 返回 drain Promise**（停机可等在途 job 收尾）。⑥ 测试 mock 收敛为共享工厂 test/helpers/redis-mock.ts（set 真写 store、eval 真模拟两段 CAS——原 mock 预置死键 "lock:cron:job"，dedup 测试的 CAS 路径实为空转）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| C3 | 入口停机顺序 | spec305/306 在 worker/api 入口接 startCronRunner 时，SIGTERM 须按 `stopAll() → await drain → closeRedis()` 收尾；乱序会让在途 tick 的释放/续租打在已断连接上（锁悬 300s）或 getRedis() 惰性重建连接 | **deferred → spec305/306 接线时** | stop 已返回 drain Promise，机制就绪，只差入口按序调用 |
| L5 | cron 测试计时 | 真实计时器 + 毫秒级 sleep（watchdog 用例 ~2.3s、tick 用例 75ms 窗口断言 ≥2）；bun:test 假计时器支持不全，暂用真时 | accepted | 立即首跑已给阈值留足余量；CI 若出现 flake 再收紧（拉长窗口/注入续租间隔） |

## spec304 · 实现留档（2026-07，收钱吧支付——Task 1–3 已完成，Task 4 真实冒烟待办）

api 入口已按 C3 顺序接线（`startCronRunner([sqb-checkin]) → SIGTERM 时 stopAll → drain → close`）。两处有据可依的契约偏差：① **`payment_orders` 加列 `credits_snapshot`（迁移 0011）**——spec301 字段清单/规格文档无此列，但 spec300-index 资金约束要求「充值到账以命中 pack 的 credits 为准（**下单时快照**）」；回调可能在运营改充值包之后才到，无快照列则只能按当前配置反查 = 违背约束。会员单（purchase/renewal）此列为 NULL，spec308 按套餐发当期积分。② **`PaymentResult` 加 `totalAmountCents`**——计划 Interfaces 的契约无此字段，但「markPaid 前必须校验实付==订单快照」是铁律，查询/回调返回的实付金额必须能穿透 Provider 抽象。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| C4 | Task 4 真实冒烟 | 端点路径（/terminal/activate、/terminal/checkin、/upay/v2/query、/upay/v2/refund、WAP2 网关 qr.shouqianba.com/gateway）与响应字段按公开资料固化，本地无收钱吧接口文档可核对 | **open → Task 4** | 拿到测试激活码后 1 分钱端到端（激活→签到→扫码付→回调/轮询→grant→退款）逐一实证；不符处只改 shouqianba.ts/terminal.ts 的常量与解析 |
| C5 | 金额不符订单滞留 | ~~amount_mismatch 不改状态，订单留 created 等对账~~ | **superseded（本轮 review 修复）** | spec306 明文不扫 created——留 created 即对账盲区。现 markPaid 对 mismatch/missing 一律置 unknown 进对账队列（见下方 spec304 code-review 段③） |

## spec304 · code-review（review 于 2026-07，钱从严——收钱吧支付全链路；8 角度含安全对抗）

背景：本 spec 初稿由越权 agent 产出，经用户确认走完整验收。安全对抗角度确认主攻击面 fail-closed（原文 RSA 验签/跨单重放被金额校验挡死/IDOR/服务端定价/GCM 随机 IV+验 tag/无密钥入日志）。修复六类资损路径：① **markPaid 的条件 UPDATE 与 grant 收进单事务**（4 角度交叉命中）——原实现 UPDATE 赢了之后 grant 抛错/进程被杀 → 订单 paid 但积分永远没发，且回调重试/轮询全被 already_final 短路、spec306 对账（paid==paid 金额也符）对此完全不可见；现在 grant 失败连状态一起回滚，任何通道重试都能重新驱动。② **paid 状态机起点扩为 created+unknown**——窗口尽头置 unknown 后迟到的 PAID 回调原来被 ack success 后丢弃（用户第 7 分钟扫码即中招）。③ **金额校验从「有金额才校验」改为「缺金额不入账」**，mismatch/missing 一律置 unknown 进对账队列并告警（原来只有一条 stderr，订单滞留 created——spec306 明文不扫 created）。④ **payment-order-sweep Cron**（每分钟扫超窗 created 单 → 问通道终态 → 补入账/关单/置 unknown）——进程重启会孤儿化 fire-and-forget 的 pollUntilFinal，这是它的结构性兜底。⑤ 配置消毒：recharge_packs 金额/积分必须正整数（credits:0 的包会「收钱不发积分」且原 >0 守卫让它静默 no-op）、payment_poll 非正数回落官方默认（fastSeconds=0 = 打爆网关的死循环）。⑥ 装配统一 getPayment() 单点（gate 含 PAYMENT_NOTIFY_BASE_URL，原来缺公网基址会签出相对路径 notify_url——回调永远到不了的半开态）；provider.parseCallback/notifyPath 收口线格式；terminal_key KDF 裸 SHA-256→scrypt；scripts/activate-terminal.ts 补运营激活入口（原来 activate() 是零调用死代码，全新环境支付必 500）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| C6 | 退款护栏 | ~~provider.refund 裸传输无护栏~~ | **done（spec306）** | createRefund：行锁下 paid 前置 + 累计（含 pending）≤ 订单额 + renewal 拒退转人工（C9）+ 扣回超余额需确认；refundSn=refunds.id 通道幂等 |
| C7 | 充值积分有效期 | 未读任何 *_expire_days，充值积分永不过期（expire_at NULL） | **decision（记录在案）** | billing-seed 无 purchase_expire_days 口径；grant/reward_expire_days 语义是赠送/奖励积分。「买的积分不过期」为当前产品决策；若定价改口需新增口径并只对新入账生效（append-only 不可回填） |
| C8 | 入口停机 drain | SIGTERM 只 drain Cron tick，不 drain 在途 HTTP/poll；轮询孤儿已由扫单 Cron 结构性兜底 | accepted | 轮询丢失的单 ≤1 分钟内被 sweep 接管；HTTP 在途属 Bun serve 生命周期，Phase 4 部署课题 |
| L6 | X-Forwarded-For | 跳转支付由顾客手机直连收钱吧，天然满足监管透传；服务端 query/refund 无顾客 IP 语义 | accepted | 计划自述「天然满足」，无需代码 |

## spec305 · code-review（review 于 2026-07，钱从严——续费闭环；8 角度含安全对抗）

修复六类问题：① **订阅行串行化**（4 角度交叉命中）——subscriptions 无 unique(user_id) 且 renewOnPaid 无行锁：并发两笔续费（不同订单，markPaid 单赢家只防同一单的双通道）读同一 base 双写同一个 +1 周期 → 付两周期得一周期（账本上两笔 grant 都在，资损不可见）；无订阅行时并发双 INSERT → 双活跃订阅。深修：unique(user_id)（迁移 0014，先清重复行）+ upsert 占位 + FOR UPDATE（spec302 lockUserBalanceRow 同款）；并发回归测试断言周期叠加 +2 月。② **权益快照**（3 角度）——只快照了价格，billingCycle/grantCreditsPerCycle 结算时实时读：运营改配置后旧价单拿新权益（年费改月费=付年价得一月，反向=套利）。深修：下单锁定全量「这笔钱买什么」（amountCents/cycleSnapshot/creditsSnapshot），结算只认快照；缺快照存量单回退+告警。③ **markPaid 按类型显式分发**——原来 recharge 分支按 creditsSnapshot 字段触发、renewal 按 type 触发，一张带快照的 renewal 单会被 purchase:/renewal: 两键各记一次=双发；createOrder 加类型不变式（renewal 必带 planId、recharge 禁带）。④ **提醒可靠性**——notify 无逐条隔离（一个坏号毒死整轮且档位被白耗）→ try/catch + 补偿删除去重行（下轮重试）；renewal_reminder_days 无形状校验（标量会 TypeError 永久断提醒）→ Array.isArray 回落；addMonths 本地时区运算（部署时区不同周期末漂移一天）→ 全 UTC。⑤ **反滥用**——/renew /recharge 开放单上限 5（每单=网关调用+6 分钟轮询，无限建单是对通道配额的放大攻击）；订单可支付窗 7 天（unknown 非终态是给真实迟到回调的门，不能变成囤旧价单等涨价的套利门；通道侧 4 分钟单有效期是第一道防线）。⑥ 扫单对持续结算失败（数据事故类）升级 unknown 进对账，不再每分钟空转到永远。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| C9 | spec306 退款 × 续费 | renewal 单退款只回扣积分不回退周期 = 退钱留会员 | **deferred → spec306** | spec306 计划已加决策口：默认 renewal 单拒绝自动退款转人工（保守），量起来再做周期回退 |
| C10 | 提醒通知渠道 | renewal-remind Cron 未注册——短信模板（阿里云需申请续费提醒模板）/站内信未就绪；console 假发送会白耗去重档位故不上 | **deferred（等模板）** | 渠道就绪后入口 `renewalCronJobs({ notify })` 一行接通；启动时有告警日志提示未注册 |
| L7 | 提醒 at-most-once 窄窗 | 「落去重行后、notify 前」进程崩溃会漏发该条（宁可漏一条不重复骚扰） | accepted | notify 运行时失败已有补偿删除重试；崩溃窄窗的彻底解需 outbox，当前量级不值 |
| L8 | markPaid 双查订单 | notify/sweep 调用方已持订单行，markPaid 再按 PK 查一次 | accepted | PK 查询开销可忽略；传行参数增加 API 面（Simplicity First） |

## spec306 · code-review（review 于 2026-07，钱从严——对账/退款/过期；8 角度）

修复核心：① **退款歧义结果语义**（4 角度交叉命中最高危）——通道调用抛错（网络超时）时钱可能已退，原实现标 failed 且 failed 不占累计额度，重试会建新 refunds 行=新 refundSn，通道视为另一笔退款照付=**双退真钱**。深修：抛错保持 pending（占额度挡住重试）→ scanStuckRefunds 落 refund_stuck 差异转人工核对通道；只有通道明确 ok:false 才 failed。② **累计比例扣回**——逐笔按全额基数取整会放大误差（3 积分退两次 50% 被扣 4）；改为「目标=round(总入账×累计退款比例)−已扣回」。③ 部分退款不再翻转订单（退满才 refunded），剩余额度可继续退。④ 扣回超当前余额（用户已消费）默认拒绝，操作员携 allowNegativeBalance 确认后放行（防"花光再退款"白嫖无感知）。⑤ 对账加固：refunded 单核对通道退款态（退款没到通道原来每天静默过账）；对账窗拓宽到 7 天可支付窗（D 日建单 D+n 日才结算的单原来永远不落任何窗口）；unknown→failed 收敛加 24h 账龄（给迟到 PAID 留门）+ notify 对终态单收到 PAID 告警；差异去重下沉 DB 部分唯一索引 (diff_type,subject) WHERE open（并发不双记、持久问题不逐日重复落、孤儿 hold 按 holdId 各留痕）；账本审计候选复查后再落（双查询快照竞态假告警）。⑥ 职责拆分：ledger-audit Cron（审计+孤儿清扫+卡死退款扫描，三段隔离）**不依赖支付凭据始终注册**——原来被 getPayment gate 连坐，无凭据环境 C1 修复静默失效。⑦ markPaid 加 allowStale（spec310 修复 unknown_paid 专用——7 天防囤单护栏原来把对账要修的单也堵死）。留档：

| # | 位置 | 问题 | 状态 | 说明 |
|---|---|---|---|---|
| C11 | 通道错误分类 | isBizQueryRejection 按抛错前缀「收钱吧查询失败」区分业务拒绝/网络抖动；refund_stuck 的人工核对亦需线上「退款查询」口径 | **deferred → Task4 冒烟校准** | 真实网关错误码拿到后收紧分类（误判方向是安全的：网络类不落 diff 只重试） |
| C12 | 告警渠道 | 对账/审计差异 alertHook 默认 console.error，生产日志无人盯≈静默；unknown_paid 是「钱收了账没入」 | **deferred → spec310** | spec310 admin 后台是差异消费口；渠道就绪前每日 cron 日志有 diffs 计数 |
| C13 | 账户注销 × 资金记录 | users 级联删会连坐 payment_orders/refunds（真实出入账记录）；当前仅测试删用户 | **deferred → 注销流程（Phase 4）** | 产品化注销必须先归档/匿名化资金记录再删行，不动 FK（reconcile_diffs 无 FK 已可幸存） |
| C14 | spec310 契约缺口 | reconcile_diffs 有 resolved 列/open 索引，但 spec310 计划无差异列表页/resolve API/unknown_paid 修复入口（markPaid allowStale） | **deferred → spec310（计划已补注）** | 见 spec310 计划头部「实现契约核对」 |
| L9 | 对账吞吐 | runReconcile 逐笔串行问通道（对通道限速友好）；auditLedger 全表两查询入内存 | accepted | 日单量到千级再上有界并发；用户到 10^5 再改 SQL JOIN 只回不一致行 |
| L10 | >24h 长任务 hold | 孤儿清扫会退还超 24h 在途 hold，迟到 settle 被唯一索引吞掉=该次用量免费（非双记） | accepted | 编排任务分钟级收尾，24h 余量充足；若未来引入长任务需调 maxAgeMs |
