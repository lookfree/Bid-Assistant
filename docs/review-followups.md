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
