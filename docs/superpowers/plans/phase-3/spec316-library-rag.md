# 资料库 RAG（pgvector 向量检索进生成链路） Implementation Plan (spec316)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把资料库从「手动粘贴的文本仓库」升级为「自动进标书的企业知识库」：① 资料条目与招标原文分句向量化入 pgvector；② content 逐章生成与单章改写时自动检索命中的资质/业绩/常用文本，注入生成上下文——用户的真实公司资料自动写进标书；③ 全链路可禁用可降级，缺 embedding key 时行为与今天完全一致。

**Architecture:** 架构文档既定归属——RAG 属 agent 服务平台层（§249：文档解析、RAG 向量检索），向量数据落 PG `agent` schema（agent 自管迁移，pgvector 0.5.1 服务器已启用）。写路径两条：资料条目由 App 在 CRUD 后 **best-effort** 通知 agent 索引（失败仅日志，绝不阻塞 CRUD）；招标 doc_sections 在 read 节点完成后就地索引（try/except 包裹，不影响读标交付）。读路径在 agent 进程内：content 节点对每个提纲章节、rewrite 对目标章，按「章标题+要点」检索 top-k，命中片段以「参考资料」段注入 prompt（带总 token 预算上限）。检索按 `user_id` 严格隔离——run 契约本轮增加 `user_id` 字段（App 从鉴权注入，agent 仅作数据隔离键，money-blind 不变）。

**Tech Stack:** Agent（pgvector + psycopg，embedding 走**自建 BGE-M3 推理服务**：轻量自建 FastAPI + sentence-transformers 包装（非 TEI，见决策记录 §7），新增容器 `bge-embed`，对外暴露 OpenAI 兼容 `/v1/embeddings`・1024 维；agent 侧 `embedder.py` 仍是纯 HTTP 客户端，不引入 torch/transformers 等重依赖到 agent 自身镜像，不依赖任何第三方 embedding API key）；App API（CRUD 钩子 + run 契约扩展 + 配置种子）；Web 本轮零改动。

## Global Constraints

- **钱的铁律**：RAG 不向用户计费（embedding/检索是平台内部成本），不新增任何 hold/settle；agent 仍只上报用量。`user_id` 进 run 契约仅作检索隔离键。
- **降级铁律**：`bge-embed` 未就绪（容器未起/探活失败）/ pgvector 不可用 / 索引失败 / 检索超时（2s）→ 生成流程照常走（无参考资料段），只记日志；资料库 CRUD 永不因索引失败报错。
- **前置条件**：新增 `bge-embed` 容器（自建 FastAPI + sentence-transformers，`BAAI/bge-m3`，CPU 推理，模型权重 fp16 ≈1.1GB，常驻内存约 1.5-2GB；首次启动需从 HuggingFace 拉权重——国内建议配 HF 镜像 `HF_ENDPOINT=https://hf-mirror.com` 或挂载预下载好的权重 volume，避免复现 mbp 此前 Docker Hub 拉取超时的问题）；权重卷做持久化避免每次重启重下。**不再依赖任何第三方 embedding API key**——实现与测试全部可先行（pytest 仍 mock embedding），mbp 部署即可端到端验收，无需等外部 key。
- **开发环境资源**（2026-07-09 实测 mbp：Apple M4 / 10 核 / 16GB 物理内存，Docker Desktop 为 `linux/arm64` 虚拟机、当前分配上限 7.98GB，9 个既有容器共占用约 2.2GB，空闲约 5.8GB）：`bge-embed` 所需 ~2GB 常驻内存 + 模型权重 1.1GB 磁盘，在现有 Docker 分配额度内直接容纳，**无需上调 Docker Desktop 内存上限**；CPU 侧索引是异步 best-effort（2s 超时降级），10 核机器批量嵌入几百毫秒到数秒级延迟完全可接受，不占用实时链路。本轮开发/测试全在 mbp 完成。
- **生产环境资源**：**不装在现有 aliyun 数据层机器**（`60.205.160.74` 实测仅 2 vCPU / 1.8GB 内存、已只剩 ~1GB 空闲，是 PG/Redis/MinIO 专用裸机，架构文档 §13.1 铁律「中间件固定单独裸机，不进无状态层集群」——塞 bge-embed 进去会和数据库抢内存）。`bge-embed` 是**无状态**服务，按架构文档 §13.2/§13.5 归入"智能体"层，和 Agent API/Agent Worker 一样部署在应用节点上，独立规格 **2 vCPU · 4 GB**（已补进架构文档资源表），**不需要为它单独申请一台专属服务器**——真正缺的是"生产应用节点"本身（目前只有 mbp 这一套 dev 部署，生产应用层尚未落地），bge-embed 作为其中一个容器随之部署即可；生产应用节点选型是比 spec316 更大的独立事项，另行推进。
- **架构兼容性铁律**：`bge-embed` 镜像必须原生支持 `linux/arm64`（mbp 开发环境）与 `linux/amd64`（未来生产应用节点，预期 x86_64）两种架构——PyTorch CPU 轮子官方两种架构都发，禁止依赖仅 x86_64 构建的镜像（如 HuggingFace TEI 官方镜像），避免在 Apple Silicon 上退化为 Rosetta/QEMU 模拟执行。
- 迁移：`agent` schema 由 services/agent 的 `agent.migrate` 自管（加迁移步骤，幂等 IF NOT EXISTS）；public schema 本轮无迁移。
- 集成测试 `./test-on-mbp.sh`；agent `uv run pytest`（embedding HTTP 一律 mock，不打真实计费接口）。
- 提交英文 Conventional Commits、lookfree、无 Co-Authored-By；函数 ≤80 行、文件 ≤800 行。

## 契约

### 数据（agent schema，agent.migrate 新步骤）
```sql
CREATE TABLE IF NOT EXISTS agent.rag_chunks (
  id          bigserial PRIMARY KEY,
  user_id     uuid        NOT NULL,           -- 隔离键（App 注入，不 FK 跨 schema）
  source_type text        NOT NULL,           -- 'library' | 'tender'
  source_id   text        NOT NULL,           -- library=条目 uuid；tender=thread_id
  chunk_no    int         NOT NULL,
  text        text        NOT NULL,
  embedding   vector(1024) NOT NULL,          -- BGE-M3 dense 输出固定 1024 维
  meta        jsonb       NOT NULL DEFAULT '{}',  -- {category?, title?, clause_id?}
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, chunk_no)
);
CREATE INDEX IF NOT EXISTS rag_chunks_scope_idx ON agent.rag_chunks (user_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS rag_chunks_hnsw_library ON agent.rag_chunks
  USING hnsw (embedding vector_cosine_ops) WHERE source_type = 'library';
```
- 换 embedding 模型=换维度=**全量重建索引**（决策记录 §3），v1 锁 1024（BGE-M3 dense 输出天然 1024 维，与原 qwen 方案维度一致，schema 不受影响）。

#### 规模治理（2026-07-13 修订，生产 EXPLAIN 实测驱动）
- **索引策略**：HNSW 只建在 `library`（partial index）——全资料库 ANN 才需要近似索引。tender 检索永远限定单项目 ~2k 行：`scope_idx` 定位 + 精确 cosine 排序，**成本与表总量无关**；沿用全局 HNSW 时多用户规模下图遍历近邻绝大多数被 user/project 过滤扔掉 → 延迟暴涨 → 触发 2s statement_timeout 静默降级为空（RAG 悄悄失效）。旧索引 `rag_chunks_hnsw`/`rag_chunks_user_idx` 由迁移 `DROP INDEX IF EXISTS` 就地删除（幂等）。
- **检索 SQL 的 source_type 必须内联字面量**（白名单校验 `'library'|'tender'` 后拼接）：绑参数时 prepared statement 的 generic plan 无法证明其匹配 partial index 谓词，会退化为全量精确扫描。
- **tender 向量生命周期**：agent-api 进程每日清扫（启动即扫一次）。删除条件=`source_type='tender'` 且 `created_at` 超过 `RAG_TENDER_TTL_DAYS`（默认 30 天）**且该项目在窗口内无任何 run**（`agent_request` 按 `thread_id` 查活跃）——超期仍在续跑/改章的项目不清，绝不让老项目静默丢检索。不是"生成完立即删"：用户生成后常回头改章/重跑审查/复制再投，立即删则这些操作全部丢 RAG，重建索引又是一次全量嵌入（大项目 20+ 分钟）。超期被清后检索降级为空（生成照常），重跑读标自动重建。
- **清扫必须分批**（每批 LIMIT 5000、独立事务，循环到删净）：无界单 DELETE 是长事务（压 vacuum、锁并发 upsert），且线程池里的语句不可取消会卡发版优雅停机；批间是 await 点，关停最多等一批。
- **写入必须批量**（executemany）：大项目 ~2000 chunks 逐行 INSERT 是 2000 次往返，曾把后台索引拖到分钟级。
- **容量结论**（2026-07 实测外推）：治理后单表支撑 1 万活跃项目 / 累计 10 万+ 项目 / 数百人并发生成；瓶颈是检索并发吃 PG CPU（单次精确检索 ~0.45s@当前规格），按量升规格即可，十万级活跃项目前无需分区或独立向量库。

### Agent 侧
1. `rag/` 新包：`embedder.py`（OpenAI 兼容 `/v1/embeddings` HTTP 客户端，指向本地 `bge-embed` 服务，env `RAG_EMBED_ENDPOINT` 默认 `http://host.docker.internal:18080/v1/embeddings`(dev,经 mbp 宿主机转发到香港 bge-embed;见记忆 bidsaas-hk-bge-embed)，无需 API key；批量≤16 条/请求；启动时探活 `/health`，探活失败或请求持续出错 → `enabled=False` 降级）、`chunker.py`（按段落切块，每块≤500 字、重叠 50）、`store.py`（psycopg upsert/delete/search，cosine top-k，2s 超时）。
2. 路由 `POST /rag/index`：body `{user_id, source_type: "library", source_id, title, text}` → 删旧 chunks → 切块 → embed → upsert → `{chunks: n}`；`DELETE /rag/index/{source_type}/{source_id}`（body/query 带 user_id 校验行属主一致才删）。RAG 禁用时返回 `{chunks: 0, disabled: true}`（200，App 无感）。
3. read 节点：产出 doc_sections 后 best-effort 索引 `(user_id, "tender", thread_id)`（clauses 已是天然分块，直接逐句入库，meta 带 clause_id）；失败仅日志。
4. content 节点：对每个提纲章节，用「章 no+标题+items 标签」作 query，检索 `source_type='library'` top-k（默认 3，run_input.rag.top_k 可调）+ 该 thread 的 tender 命中 top-2；命中拼「【参考资料·仅供撰写引用】」段注入该章上下文，总预算 ≤2000 字。rewrite_chapter 同款（query=章标题+instruction）。
5. run 契约：`CreateRunBody`/rewrite body 增 `user_id: str | None`（照 spec311 `model` 的加法）；`run_input.rag = {enabled, top_k}` 由 App 下发；user_id 缺失 → RAG 静默跳过。

### App API 侧
1. run 契约：`createRun`/`rewriteChapter` 调用统一带 `user_id`（从鉴权取）；steps 路由 `run_input.rag` 从 `getConfigs("rag.")` 组装。
2. library CRUD 钩子（routes/library.ts）：POST/PUT 成功后 best-effort `agentClient.ragIndex({userId, sourceId: item.id, title, text: title+meta+body+fields 拼接})`；DELETE 后 `ragDelete`。均独立 try，失败 console.warn，不影响响应。agent-client 加两方法（超时 30s）。
3. 配置种子：billing-seed 加 `rag.enabled`（默认 true——agent 侧无 key 自会禁用）、`rag.top_k`（默认 3），运营后台既有 configs UI 直接可改。
4. 手动重建入口：`POST /api/library/reindex`（登录用户全量重建自己的条目,遍历调 ragIndex;给资料库页后续加按钮预留,本轮仅 API）。

### 部署（deploy compose 新增第 7 个容器）
- `deploy/docker-compose.yml` 新增 `bge-embed` 服务：**自建**镜像（`bge-embed/Dockerfile`，`python:3.12-slim` 基础层 + `sentence-transformers`+`torch`(CPU 轮子，无 CUDA) + 极简 FastAPI，加载 `BAAI/bge-m3` 后暴露 `POST /v1/embeddings`〔OpenAI 兼容请求/响应体〕与 `GET /health`）；挂 named volume 缓存 HF 权重（避免每次 `docker compose up` 重下 1.1GB）；`agent-api`/`agent-worker` 通过 `RAG_EMBED_ENDPOINT=http://bge-embed:8000/v1/embeddings` 访问，同一 docker network 内不出公网。
- **必须原生支持 `linux/arm64`（mbp）与 `linux/amd64`（未来生产应用节点）双架构**——不用 HuggingFace TEI 官方镜像（无可靠 arm64 构建，会在 Apple Silicon 上退化为模拟执行）；`docker buildx build --platform linux/amd64,linux/arm64` 出双架构镜像，torch CPU 轮子两种架构官方都发，原生运行。
- 拉镜像/权重如遇 HuggingFace 访问超时，走 HF 镜像站（`HF_ENDPOINT=https://hf-mirror.com`）或本地预下载权重目录挂载，参考此前 `docker.m.daocloud.io` 解 Docker Hub 超时的同类做法。

### 验证口径
- agent pytest：chunker 边界（空/超长/中文段落）、store upsert/属主隔离/超时降级（mock psycopg 慢查询）、embedder 探活失败降级、content 节点注入参考资料段（mock embedding 返回固定向量）、read 节点索引失败不影响交付、rewrite 检索注入。
- api mbp：CRUD 钩子 best-effort（agent 抛错 CRUD 仍 200）、run input 带 user_id 与 rag 配置断言、reindex 属主隔离。
- 端到端（部署后手测）：`bge-embed` 容器起来且探活通过 → 建资料条目 → 跑 content → 章节正文体现资料内容。

## Tasks

- [x] **Task A（agent）**：迁移 + rag 包（embedder 指向本地 bge-embed） + 双路由 + read/content/rewrite 接入 + pytest（embedding 全 mock）
- [x] **Task B（api）**：run 契约 user_id + CRUD 钩子 + rag 配置种子/下发 + reindex + mbp 测试
- [x] **Task C（部署）**：compose 加 `bge-embed` 容器 + 权重卷 + env 接线 → /code-review 全修 → 双侧全绿 → commit → 部署 mbp（容器未就绪时验证「禁用态=行为与今天一致」）
- [x] **Task D**：确认 `bge-embed` 权重下载完成、`/health` 探活通过 → 端到端验收「资料自动进标书」（不再需要人工提供第三方 API key）

## 决策记录

1. 向量落 `agent` schema、agent 自管——App 不引 pgvector 依赖，业务/AI 边界与架构文档一致；App 与向量的唯一接触面是两个 best-effort HTTP 调用。
2. 资料索引走「App 通知」而非 agent 轮询/CDC：链路最短、无新基建;漏索引的兜底是手动 reindex(v1 够用,审计对账留候选)。
3. 维度锁 1024（BGE-M3 dense 输出天然 1024 维);换模型=全量重建,不做多维度共存。
4. RAG 不计费:embedding 成本是平台侧的,类比读标时的解析成本;若未来要按次收费,挂点在 App(照 rewrite 范式),本轮明确不做。
5. tender 向量以 thread_id 为 source_id;生命周期清理已于 2026-07-13 落地为「每日活跃感知清扫」(见 Schema「规模治理」小节),项目删除功能上线时再补删除钩子(复用 DELETE /rag/index)。
6. **改选自建 BGE-M3 而非调用 qwen/glm 云 API**：省去第三方 embedding key 依赖与外部调用延迟/配额风险，资源成本可控（CPU 即可，mbp 现有服务器有余量，无需 GPU，实测见 Global Constraints「服务器资源配置」）；代价是新增一个容器 + 一次性模型权重下载，且索引场景需要在 agent-api（CRUD 钩子触发的 /rag/index）和 agent-worker（read/content/rewrite 节点检索）两个进程都能访问 —— 用独立 HTTP 服务而非把 torch/transformers 打进 agent 自身镜像，正是为了避免双进程各自常驻一份 ~2GB 模型的内存翻倍开销，embedder.py 对 agent 代码而言仍是「纯 HTTP 客户端」，架构不变。
7. **自建镜像而非 HuggingFace TEI**：2026-07-09 实测 mbp Docker 是 `linux/arm64`（Apple M4），TEI 官方镜像只面向 x86_64+AVX2 构建，在 arm64 上无可靠原生镜像、会退化为模拟执行；改用一个基于 `sentence-transformers`+CPU 版 torch 的极简自建 FastAPI 服务，`docker buildx` 出 arm64/amd64 双架构镜像，mbp（开发）与未来生产应用节点（预期 x86_64）都原生运行，代价是自己维护这一个小镜像（Dockerfile + 依赖锁定），换取跨架构一致性。

## 本轮不做（候选池）

- 审核表 libraryMatch 语义化(检索端点现成后一步之遥,等 RAG 验收后做)
- 「从资料库插入」弹层的语义搜索框、章节生成结果显示「引用了 N 条资料」溯源 UI
- ~~孤儿向量 GC~~（2026-07-13 已落地为每日活跃感知清扫）;索引对账;按次计费;多 embedding 供应商共存
