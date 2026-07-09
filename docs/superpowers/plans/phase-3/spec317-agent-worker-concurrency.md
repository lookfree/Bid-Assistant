# Agent Worker 并发模型改造 Implementation Plan (spec317)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `services/agent` 的 worker 进程能**同时推进多个不同标书(不同 run_id/thread_id)的生成任务**——C 端多用户并发点"生成"时不再排队等前一个用户跑完。单个标书内部的节点顺序（read→outline→content→review→present）不变，仍严格串行；改的是"不同标书之间能否同时跑"。

**Architecture:** 现状是 `main_worker.py` 的消费循环 `count=1` 严格串行——一条 Redis Stream 消息的 `process_run` 完全跑完才读下一条，同时循环里和 `executor.py`/`Recorder` 里大量用**同步**的 `redis.Redis`/`psycopg_pool.ConnectionPool` 直接在 `async def` 里调用（未 `to_thread` 卸载），这些同步调用会阻塞整个进程唯一的事件循环。改造分两层：① 消费循环从"读一条→等跑完→读下一条"改成"信号量限流的并发派发"（同时最多 `AGENT_WORKER_CONCURRENCY` 个 run 在跑，读消息与已跑任务的完成互不等待）；② 把所有会阻塞事件循环的同步 Redis/Postgres 调用逐一 `asyncio.to_thread` 卸载（`nodes/read.py`、`dedupe/` 已经这样做过，是既有先例，这次是把同样的处理补到 `executor.py`/`main_worker.py`/`Recorder` 调用点）。LangGraph 的 `AsyncPostgresSaver`（checkpointer）本身已是原生异步，不用动。③ 认领路径（`XAUTOCLAIM`）语义从"重试执行"改为**孤儿清理**——重试语义属于上层（App 侧失败提示/自愈 + 用户显式重新点击产生新 run_id + LangGraph checkpointer 按 thread_id 续跑），队列层只负责不丢未投递消息和清理死进程遗留，绝不代行重试（决策记录 §3）。

**Tech Stack:** Python 3.12 + asyncio（`asyncio.Semaphore`/`asyncio.wait`/`asyncio.to_thread`），复用现有 `redis`（sync client）+ `psycopg_pool.ConnectionPool`（sync pool，不换 async 版本——`to_thread` 卸载已够用，换 async pool 是大得多的改造，本轮不做，见决策记录）；测试 `uv run pytest`（`pytest-asyncio` `asyncio_mode=auto`，已配好）。

## Global Constraints

- **不改单个标书内部的节点顺序**：`bidding_agent` 的 `NODE_ORDER`/`interrupt_after` 不动，read→outline→content→review→present 依旧严格线性，本轮只改"不同 run_id 之间"的并发。
- **money-blind 不变**：本轮不碰计费/hold/settle，agent 服务本来就只上报用量,这次改动在 agent 内部,和 App API 的钱路径无接触面。
- **不引入新中间件/新依赖**：不换 async Postgres 连接池，不加消息队列，只用标准库 `asyncio` + 现有 `redis-py`/`psycopg_pool`（sync，靠 `to_thread` 卸载）。
- **`AGENT_WORKER_CONCURRENCY` 默认值要保守**：默认 `5`——内容生成大部分时间在等外部 LLM API（I/O 等待，不吃 CPU/GIL），但 read 步骤的文档解析、dedupe 的图片哈希是真 CPU 计算，`asyncio.to_thread` 默认线程池撑不住无限并发；默认值先保守，压测后再调（决策记录 §2）。
- **认领路径改语义：清道夫（janitor），绝不重新执行**：认领机制的职责收敛为"清理死进程烂在 PEL 里的消息"——终态 ack 收尾、孤儿标失败，任何分支不调 `process_run`。重试语义不属于队列层（决策记录 §3）。`CLAIM_MIN_IDLE_MS` 保持 60s 原值：正因为认领后不执行任何东西，低阈值只意味着孤儿更快被清理、用户更快看到确定性失败。
- 提交英文 Conventional Commits、lookfree、无 Co-Authored-By；函数 ≤80 行、文件 ≤800 行；关键方法要有注释（说明"为什么"，不写"是什么"）。
- 验证口径：`cd services/agent && uv run pytest`；full pass 后按标准流程 `/code-review` 全修 → mbp 集成测试（`./test-on-mbp.sh` 或直接部署）→ commit → 部署 mbp → 手测"多个标书同时点生成，进度互不阻塞"。

## 契约

### 现状代码（本轮要动的文件，行号为改造前）
- `services/agent/src/agent/main_worker.py`：`run_loop()`（65-83）严格串行；`handle_entry()`（44-53）`r.xack` 同步；`claim_stale()`（56-62）`r.xautoclaim` 同步；`ensure_group()`（33-41）`r.xgroup_create` 同步。
- `services/agent/src/agent/runtime/executor.py`：`process_run()`（38-88）里 `r.get`/`r.set`（44,80）、`rec.start_run/log_event/finish_run`（53,54,71-72,79,84-85）、`_publish()`（28-35，含 `pipe.execute()`）全同步直调，未 `to_thread`。
- `services/agent/src/agent/telemetry/recorder.py`：`Recorder` 全部方法基于同步 `psycopg_pool.ConnectionPool`（`self._pool.connection()`），本身不用改——改的是**调用点**用 `to_thread` 卸载，不改 `Recorder` 自身实现（保持同步、简单，不做 async 化大改造）。
- `services/agent/src/agent/config.py`：`Settings`（19-52）新增一个字段。

### Agent 侧改动
1. **`config.py`**：`Settings` 加 `agent_worker_concurrency: int = 5`（env `AGENT_WORKER_CONCURRENCY`，与既有字段同风格，pydantic-settings 大小写不敏感匹配）。
2. **`executor.py`**：`process_run`/`_publish`/`_callback` 里所有同步 Redis(`r.get`/`r.set`/`_publish` 内的 pipeline)、同步 Postgres(`rec.*`) 调用点，逐个 `await asyncio.to_thread(fn, *args)` 包裹。`_rec()`/`_gateway` 等模块级单例不变。
3. **`main_worker.py`**：
   - `run_loop()` 改造为**信号量限流的并发派发**：维护 `pending: set[asyncio.Task]` 与 **in-flight entry_id 集合**（task 创建时登记、回收时移除），容量 = `settings.agent_worker_concurrency - len(pending)`；有容量才发起 `xreadgroup`（`to_thread` 包裹，`count=capacity`）；每条消息 `asyncio.create_task(handle_entry(...))` 加入 `pending`；`pending` 非空时用短超时 `asyncio.wait(..., return_when=FIRST_COMPLETED)` 回收已完成任务腾出容量（同时兼顾定期 `claim_stale` 检查）。
   - **回收必须消费任务异常**：对已完成 task 逐个 `task.result()` 包 try/except 打日志——`handle_entry` 内 `process_run` 的异常已自吞，但 `xack` 抛 RedisError 会悬在 task 上（"Task exception was never retrieved"），必须显式取出记日志；该消息留在 pending，由认领机制兜底，消费循环不受影响。
   - **`claim_stale` 跳过 in-flight 条目**：`XAUTOCLAIM` 认领只看 idle 时间、不区分属主——并发模型下 worker 自己还在正常跑的消息，idle 一超阈值就会被自己认领到（串行模型靠"循环卡在 await 里、轮不到 claim 执行"这个副作用天然免疫，并发化后免疫消失）。认领结果先按 in-flight 集合过滤：**过滤后仍认领得到的消息，在单实例部署下属主进程必已消亡（孤儿）**——这是下一条"敢直接标失败"的前提（决策记录 §3/§6）。
   - **认领路径 = 孤儿清理（清道夫），永不重新执行**：对过滤后的认领消息查 `agent.agent_request.status`（run_id 主键单点查询，`to_thread` 包裹），三类处置：①**终态**（`succeeded`/`failed`）→ 只 ack——上次执行完整跑完、只是收尾 `xack` 失败没确认掉，关掉旧注释"至多重复执行一次，可接受"的窗口；②**非终态**（`queued`/`running`）→ 孤儿（in-flight 过滤保证属主已死）：`finish_run(status='failed', error='orphaned: worker exited mid-run')` + 往进度流 `_publish` `run.end failed` + ack——App 的 SSE 中继若还在听立即看到失败，卡死自愈的"agent 报告 run failed"条件提前满足，不必等 10 分钟年龄兜底；③**查无记录**（远古脏消息）→ 记日志 + ack。**任何分支都不调 `process_run`**——重试 = 用户在 App 重新发起的新 run_id（LangGraph checkpointer 按 thread_id 从上次完成节点续跑，已完成步骤成果不丢），队列层不代行重试（决策记录 §3）。正常消费路径（`>` 新消息）不查库——run_id 一次性生成，新消息不可能已完成，热路径不加库往返。
   - `handle_entry`/`ensure_group`/`claim_stale` 里的同步 Redis 调用（`xack`/`xgroup_create`/`xautoclaim`）同样 `to_thread` 包裹；`claim_stale` **保持内部顺序 await**（不接入并发派发——认领批量小(≤10)、频率低(60s 一次)，正确性优先于吞吐，见决策记录 §4）。
   - `CLAIM_MIN_IDLE_MS` 保持 `60_000` 不变，但注释重写：旧语义"idle 60s = 死消费者，认领重跑"改为"idle 60s 且不在本进程 in-flight = 孤儿，清理标失败"。低阈值在清道夫语义下是优点（孤儿 1-2 分钟内被清理、失败快速可见）；多实例部署前必须重估——跨实例时 in-flight 过滤失效，60s 会把其他实例健康在跑的 run 误标失败，先加心跳列或大幅上调阈值（决策记录 §6）。
4. **模板/部署文档**：`.env.bidsaas.example` 补一行 `AGENT_WORKER_CONCURRENCY=` 及注释（agent 服务的 Redis 配置块附近）。部署侧零改动——compose 的 agent-worker 已 `env_file: [.env.deploy.local]` 透传，mbp 调参只需在该文件加一行；**「10 并发生成」目标的落地路径**：默认 5 上线 → mbp 压测观测 CPU/单 run 耗时 → 达标则调 `AGENT_WORKER_CONCURRENCY=10`（或架构文档 §13.4 的 2 副本×5，多实例前先解决跨实例判活——决策记录 §6 心跳列），本轮交付默认值即可。

### 验证口径
**并发/重叠一律用事件握手证明，禁止墙钟计时断言**（"总耗时≈单次耗时"这类断言在高负载 CI/mbp 上必然间歇性挂——重叠性要由逻辑证明，不靠钟表）：
- `test_model_config.py` 或新测试：`Settings` 默认 `agent_worker_concurrency == 5`，env 覆盖生效。
- `test_executor.py` 新增并发重叠测试：两个 `process_run` 并发跑（`asyncio.gather`），fake 的阻塞调用点里做**双向事件握手**——A 置位 `event_a` 后等 `event_b`（带超时兜底），B 反之；两者都能等到对方 = 证明确实卸载到线程池、互不阻塞（若仍互相阻塞，握手死锁、超时失败）。
- `test_worker_group.py` 新增：①并发派发测试——多条慢消息（fake `process_run` 等事件放行）进来时，同时在跑的 task 数达到并发上限但不超过 `AGENT_WORKER_CONCURRENCY`，且第 N+1 条在有任务完成前不被派发；②**in-flight 排除测试**——`claim_stale` 的认领结果包含一条正在 in-flight 集合中的 entry_id 时，该条被跳过不处置、也不 ack（等属主任务自己收尾）；③**清道夫永不执行测试**——认领路径任何分支都不调 `process_run`：终态 run → 仅 ack；非终态（`running`）run → `finish_run` 被调为 `failed` + 进度流收到 `run.end failed` + ack；查无记录 → 记日志 + ack；④任务异常回收测试——`handle_entry` 的 `xack` 抛 RedisError 时，循环存活、异常被消费记日志（无未取回异常告警）。
- mbp 手测：并发触发 2-3 个不同项目的 content 生成，观察 SSE 进度是否交替推进（而不是一个跑完另一个才开始）；查 `agent.agent_event_log` 里不同 run_id 的 `created_at` 时间戳是否有重叠。

## Tasks

- [ ] **Task A（config）**：`Settings` 加 `agent_worker_concurrency` 字段 + 默认值/env 覆盖测试 + `.env.bidsaas.example` 补注释。
- [ ] **Task B（executor 卸载）**：`executor.py` 全部同步调用点 `to_thread` 包裹 + 并发重叠测试（事件握手）证明不再互相阻塞。
- [ ] **Task C（worker 并发派发 + 清道夫）**：`main_worker.py` 改造 `run_loop` 为信号量限流并发派发（含 in-flight entry_id 登记/排除 + 任务异常回收）+ 认领路径改孤儿清理语义（终态 ack / 非终态标失败发 run.end / 永不重执行）+ 同步调用点卸载 + 对应测试。
- [ ] **Task D**：`uv run pytest` 全绿 → `/code-review` 全修 → 部署 mbp → 手测多标书并发生成验收。

## 决策记录

1. **不换 async Postgres 连接池 / 不把 `Recorder` 改成 async**：`asyncio.to_thread` 卸载已经解决"阻塞事件循环"这个核心问题，`Recorder` 每次调用都是毫秒级短查询，线程池卸载的开销可忽略；换 `AsyncConnectionPool` + 把 `Recorder` 全部方法改 `async def` 是大得多的改造（涉及所有调用点签名变化），性价比不如原地卸载，本轮不做。
2. **`AGENT_WORKER_CONCURRENCY` 默认 5，不是拍脑袋定更高**：content 生成大部分时间在等外部 LLM API（真正的 I/O 等待），理论上可以开得更高；但 read/dedupe 这类 CPU 密集工作走的是 `asyncio.to_thread` 默认线程池（`min(32, cpu_count+4)`），并发调高之后如果同一时刻好几个都在跑 CPU 密集步骤，会真的抢 CPU、拖慢彼此，且和 App 侧"运行超 10 分钟判定卡死"（`apps/api/src/services/stuck-steps.ts`）的自愈阈值有潜在冲突——并发数开太高、CPU 竞争严重时，单个 run 有可能被拖过 10 分钟触发误判退款重跑。默认保守值 5，真实压测后再按数据上调，不预先优化未知场景。
3. **认领语义从"重试执行"改为"孤儿清理"，`CLAIM_MIN_IDLE_MS` 保持 60s**：重试不属于队列层——本系统的重试链路本来就是"App 侧失败提示/卡死自愈 → 用户显式重新点击 → 新 run_id 入队正常消费 → LangGraph checkpointer 按 thread_id 从上次完成节点续跑（已完成成果不丢）"，旧消息重新执行在这条链路里没有位置。队列层代行重试有三宗罪：①和 App 10 分钟卡死自愈撞车——App 已退款标失败后 run 又"复活"跑完，交付了没人付钱的僵尸结果；②计费步骤必须由用户显式点击发起（产品铁律），队列重执行没有对应的用户点击；③只有"要重执行"才被迫区分"崩了还是在跑"这个无解判断，"只清理"则只需 in-flight 过滤（单实例下过滤后认领到的必是孤儿，无歧义）。清道夫化之后低阈值反而是优点：孤儿消息 1-2 分钟内被标失败，App 自愈的"agent 报告 run failed"条件提前满足（不必等 10 分钟年龄条件），用户更快看到确定性失败、更快能重试。
4. **`claim_stale` 认领批次保持顺序 await，不接入并发派发**：这个路径是"死消费者遗留消息"的兜底恢复，频率低（60s 一次）、批量小（≤10 条），正确性优先于吞吐；接入并发派发会让 `pending` 容量管理变复杂（认领批次可能短暂突破并发上限），为一个低频兜底路径承担这个复杂度不值得。
5. **不做"单个标书内部章节并行生成"**：本轮的并发是"不同 run_id 之间"，不改 LangGraph 图本身的线性节点顺序——章节内容目前是逐章调用 `content` 节点顺序生成，若要章节间并行生成是另一个量级的改动（涉及模型上下文一致性、图结构改造），不在本轮范围内。
6. **库记录能当"完成判据"，不能当"存活判据"**：清道夫查 `agent_request.status` 决定处置——终态（`succeeded`/`failed`）是**单向终态**，查到即事实、据此 ack 收尾无歧义；但 `status` 非终态本身**不构成**"属主已死"的证据（崩溃的 worker 留下的恰恰是永远的 `running`），清道夫敢把非终态标失败，依据不是库、而是"in-flight 过滤 + 单实例部署"保证认领到的必是孤儿。同理评估过、否决掉的活性判据：`agent_event_log` 新鲜度（只在节点边界写，content 节点内一次 LLM 调用可以几分钟无事件，新鲜度阈值只能放到分钟级=退化成又一个超时启发式）；`agent_token_usage`（run 中零散落行、间隔不可控）——它的真实价值是**事后审计**，僵尸/重复执行会留下双份用量行，可检可对账，是"发现"不是"预防"。**多实例扩容时** in-flight 过滤跨不了进程，"属主已死"要重新可判定，正解是**心跳列**：在跑的 worker 每 ~10s 更新一次 `agent_request` 的心跳时间戳（等价于周期性 XCLAIM 刷 idle），清道夫改判"非终态 + 心跳过期 = 孤儿"——留作多实例升级项，届时 `CLAIM_MIN_IDLE_MS` 的判活角色由心跳接管。
7. **checkpointer 单连接串行化：已知、可接受、留升级路径**：`checkpointer.py` 的 `AsyncPostgresSaver.from_conn_string` 底下是**一条**共享 AsyncConnection（不是连接池），psycopg3 连接内部锁保证并发安全但操作排队——并发 run 的每步 checkpoint 写会互相串行。并发 5 时每次写是毫秒到几十毫秒级、远小于节点本身的 LLM 等待，不构成瓶颈，本轮不动。**升级路径两条（按优先序）**：①**加 worker 副本**（架构文档 §13.4 既定扩容方式）——该连接是每进程一条的模块级单例，加副本=加连接，2 副本×并发 5 时每条连接仍只服务 5 个 run，串行点随算力天然分摊，且同时分摊 CPU；前提是先解决跨实例判活（心跳列，§6）、且共享 PG 要有生产规格（架构文档给 PG 4 vCPU/16GB 独立裸机——当前 dev 那台 2 核/1.8GB 撑不住多副本的连接与写负载，先扩数据层再堆副本）。②单进程内调高并发且 profiling 显示 checkpoint 写排队时，改 `checkpointer.py` 为 `AsyncConnectionPool` 挂载 `AsyncPostgresSaver`。把这根隐形的串行栓写在这里，避免后人调参时踩到查不出的地板。

## 本轮不做（候选池）

- Postgres/Redis 换纯 async 客户端（`Recorder` async 化、`redis.asyncio`）——见决策记录 §1，`to_thread` 卸载够用。
- 单标书内章节并行生成——见决策记录 §5。
- `AGENT_WORKER_CONCURRENCY` 按 CPU 占用率自动调节（类似 KEDA/HPA 那套）——起步阶段先固定值 + 压测，动态调节留给真正上 k3s（架构文档 §13.6）以后。
- App 侧"运行超 10 分钟判定卡死"阈值联动调整——如果并发上线后真的观测到误判，再单独处理（决策记录 §2 已标注这个风险点，留给压测数据说话）。
