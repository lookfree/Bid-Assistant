# 资料库 RAG（pgvector 向量检索进生成链路） Implementation Plan (spec316)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把资料库从「手动粘贴的文本仓库」升级为「自动进标书的企业知识库」：① 资料条目与招标原文分句向量化入 pgvector；② content 逐章生成与单章改写时自动检索命中的资质/业绩/常用文本，注入生成上下文——用户的真实公司资料自动写进标书；③ 全链路可禁用可降级，缺 embedding key 时行为与今天完全一致。

**Architecture:** 架构文档既定归属——RAG 属 agent 服务平台层（§249：文档解析、RAG 向量检索），向量数据落 PG `agent` schema（agent 自管迁移，pgvector 0.5.1 服务器已启用）。写路径两条：资料条目由 App 在 CRUD 后 **best-effort** 通知 agent 索引（失败仅日志，绝不阻塞 CRUD）；招标 doc_sections 在 read 节点完成后就地索引（try/except 包裹，不影响读标交付）。读路径在 agent 进程内：content 节点对每个提纲章节、rewrite 对目标章，按「章标题+要点」检索 top-k，命中片段以「参考资料」段注入 prompt（带总 token 预算上限）。检索按 `user_id` 严格隔离——run 契约本轮增加 `user_id` 字段（App 从鉴权注入，agent 仅作数据隔离键，money-blind 不变）。

**Tech Stack:** Agent（pgvector + psycopg，embedding 走 OpenAI 兼容 HTTP：qwen text-embedding-v3 · 1024 维，或 glm embedding-3；不引 SDK）；App API（CRUD 钩子 + run 契约扩展 + 配置种子）；Web 本轮零改动。

## Global Constraints

- **钱的铁律**：RAG 不向用户计费（embedding/检索是平台内部成本），不新增任何 hold/settle；agent 仍只上报用量。`user_id` 进 run 契约仅作检索隔离键。
- **降级铁律**：无 embedding key / pgvector 不可用 / 索引失败 / 检索超时（2s）→ 生成流程照常走（无参考资料段），只记日志；资料库 CRUD 永不因索引失败报错。
- **前置条件**：需要 `DASHSCOPE_API_KEY`（qwen，推荐）或 `ZHIPU_API_KEY`（glm）之一——DeepSeek 无 embedding API，当前 mbp 只配了 DeepSeek key，**拿到 key 前 RAG 保持禁用态**（实现与测试全部可先行，用 mock embedding 验证）。
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
  embedding   vector(1024) NOT NULL,          -- qwen text-embedding-v3 固定 1024 维
  meta        jsonb       NOT NULL DEFAULT '{}',  -- {category?, title?, clause_id?}
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, chunk_no)
);
CREATE INDEX IF NOT EXISTS rag_chunks_user_idx ON agent.rag_chunks (user_id, source_type);
CREATE INDEX IF NOT EXISTS rag_chunks_hnsw ON agent.rag_chunks USING hnsw (embedding vector_cosine_ops);
```
- 换 embedding 供应商=换维度=**全量重建索引**（决策记录 §3），v1 锁 1024。

### Agent 侧
1. `rag/` 新包：`embedder.py`（OpenAI 兼容 `/v1/embeddings` HTTP 客户端，qwen/glm 二选一按 env `RAG_EMBED_PROVIDER`+对应 key；批量≤16 条/请求；无 key → `enabled=False`）、`chunker.py`（按段落切块，每块≤500 字、重叠 50）、`store.py`（psycopg upsert/delete/search，cosine top-k，2s 超时）。
2. 路由 `POST /rag/index`：body `{user_id, source_type: "library", source_id, title, text}` → 删旧 chunks → 切块 → embed → upsert → `{chunks: n}`；`DELETE /rag/index/{source_type}/{source_id}`（body/query 带 user_id 校验行属主一致才删）。RAG 禁用时返回 `{chunks: 0, disabled: true}`（200，App 无感）。
3. read 节点：产出 doc_sections 后 best-effort 索引 `(user_id, "tender", thread_id)`（clauses 已是天然分块，直接逐句入库，meta 带 clause_id）；失败仅日志。
4. content 节点：对每个提纲章节，用「章 no+标题+items 标签」作 query，检索 `source_type='library'` top-k（默认 3，run_input.rag.top_k 可调）+ 该 thread 的 tender 命中 top-2；命中拼「【参考资料·仅供撰写引用】」段注入该章上下文，总预算 ≤2000 字。rewrite_chapter 同款（query=章标题+instruction）。
5. run 契约：`CreateRunBody`/rewrite body 增 `user_id: str | None`（照 spec311 `model` 的加法）；`run_input.rag = {enabled, top_k}` 由 App 下发；user_id 缺失 → RAG 静默跳过。

### App API 侧
1. run 契约：`createRun`/`rewriteChapter` 调用统一带 `user_id`（从鉴权取）；steps 路由 `run_input.rag` 从 `getConfigs("rag.")` 组装。
2. library CRUD 钩子（routes/library.ts）：POST/PUT 成功后 best-effort `agentClient.ragIndex({userId, sourceId: item.id, title, text: title+meta+body+fields 拼接})`；DELETE 后 `ragDelete`。均独立 try，失败 console.warn，不影响响应。agent-client 加两方法（超时 30s）。
3. 配置种子：billing-seed 加 `rag.enabled`（默认 true——agent 侧无 key 自会禁用）、`rag.top_k`（默认 3），运营后台既有 configs UI 直接可改。
4. 手动重建入口：`POST /api/library/reindex`（登录用户全量重建自己的条目,遍历调 ragIndex;给资料库页后续加按钮预留,本轮仅 API）。

### 验证口径
- agent pytest：chunker 边界（空/超长/中文段落）、store upsert/属主隔离/超时降级（mock psycopg 慢查询）、embedder 无 key 禁用、content 节点注入参考资料段（mock embedding 返回固定向量）、read 节点索引失败不影响交付、rewrite 检索注入。
- api mbp：CRUD 钩子 best-effort（agent 抛错 CRUD 仍 200）、run input 带 user_id 与 rag 配置断言、reindex 属主隔离。
- 端到端（部署后手测）：建资料条目 → 跑 content → 章节正文体现资料内容（有 key 后验收）。

## Tasks

- [ ] **Task A（agent）**：迁移 + rag 包 + 双路由 + read/content/rewrite 接入 + pytest（embedding 全 mock）
- [ ] **Task B（api）**：run 契约 user_id + CRUD 钩子 + rag 配置种子/下发 + reindex + mbp 测试
- [ ] **Task C**：/code-review 全修 → 双侧全绿 → commit → 部署 mbp（无 key 时验证「禁用态=行为与今天一致」）
- [ ] **Task D（人工）**：用户提供 DASHSCOPE_API_KEY（或 ZHIPU）→ 配 env 重启 → 端到端验收「资料自动进标书」

## 决策记录

1. 向量落 `agent` schema、agent 自管——App 不引 pgvector 依赖，业务/AI 边界与架构文档一致；App 与向量的唯一接触面是两个 best-effort HTTP 调用。
2. 资料索引走「App 通知」而非 agent 轮询/CDC：链路最短、无新基建;漏索引的兜底是手动 reindex(v1 够用,审计对账留候选)。
3. 维度锁 1024(qwen text-embedding-v3);换供应商=全量重建,不做多维度共存。
4. RAG 不计费:embedding 成本是平台侧的,类比读标时的解析成本;若未来要按次收费,挂点在 App(照 rewrite 范式),本轮明确不做。
5. tender 向量以 thread_id 为 source_id,项目删除的清理留给「孤儿向量 GC」候选(体量小,不阻塞)。

## 本轮不做（候选池）

- 审核表 libraryMatch 语义化(检索端点现成后一步之遥,等 RAG 验收后做)
- 「从资料库插入」弹层的语义搜索框、章节生成结果显示「引用了 N 条资料」溯源 UI
- 孤儿向量 GC、索引对账;按次计费;多 embedding 供应商共存
