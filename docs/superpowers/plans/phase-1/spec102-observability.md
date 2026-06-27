# spec102 · 观测与埋点（横切能力） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 bidsaas 库 **`agent` schema** 建智能体运行观测表（`agent_request`/`agent_event_log`/`agent_token_usage`/`agent_tool_call`，**每表带 `agent_type`**，token 记 **input/output/cached**），并提供统一 `Recorder` 埋点器，供运行时（spec104）与各能力（spec106）记录 run 生命周期、事件时间线、模型用量、工具调用。

**Architecture:** 表用幂等 DDL `setup_telemetry(pool)` 建（与框架 `checkpointer.setup()` 同思路，spec104 当迁移跑一次）。`Recorder` 基于 spec101 的 psycopg 连接池写库；用量汇总供 App 结算回传消费。所有表归 `agent` schema，与 `langgraph`（checkpointer）、`public`（App 业务）分离。

**Tech Stack:** Python、psycopg(3)、pytest。

## Global Constraints

见 `spec100-index.md`。本 spec 关键约束：
- 表落 bidsaas **`agent` schema**；**每张表含 `agent_type`**；时间戳 `timestamptz`。
- `agent_token_usage` 记 **input/output/cached**（与 total）四类 token——回传 App 结算的用量来源。
- 不碰钱、只记数据（§3.2）；输入/事件 payload 默认脱敏/截断。
- 集成测试连真 bidsaas（agent schema），自清理。
- 在 `main` 上先开分支；提交信息结尾附 Co-Authored-By。

---

## ID 语义（统一口径，全 Phase 1 通用）

| ID | 含义 | 关系 |
|---|---|---|
| **run_id** | **一次执行**（一个任务跑一遍）；App 建 run 时生成；`agent_request` 主键 | 一个 thread 下可有多个 run |
| **thread_id** | **会话/对话** = **LangGraph 原生 `thread_id`**（checkpointer 按它续状态）；同一会话多 run 共享状态（多轮改写 / HITL 恢复） | 传给 LangGraph 即 `config.configurable.thread_id` |

> 只用两个 ID。**不用 `conversation_id`**（会话键统一 `thread_id`）；**不设 `request_id`**（与 `run_id` 在当前阶段 1:1 冗余，HITL/重试可由 `event_type`+`seq` 区分）。将来上**分布式追踪**时再加边缘生成的 `trace_id`（跨服务、与 run_id 不同层）。

---

## File Structure

```
services/agent/src/agent/telemetry/
├── __init__.py
├── schema.py                       # 新：agent schema + 四表 DDL + setup_telemetry(pool)
└── recorder.py                     # 新：Recorder（start_run/log_event/record_usage/record_tool/finish_run/usage_summary）
services/agent/tests/
├── test_telemetry_schema.py        # 新：建表幂等 + 四表存在
└── test_recorder.py                # 新：埋点写入 + 用量汇总（真库）
```

---

## Interfaces（本 spec 对外产出，供 spec104/106/107 依赖）

- Produces：
  - `setup_telemetry(pool) -> None`（幂等建 `agent` schema 与四表，spec104 迁移时调用）。
  - `Recorder(pool)`：
    - `start_run(run_id, agent_type, thread_id, file_refs=None, input_summary=None)`
    - `log_event(run_id, agent_type, event_type, node=None, level="info", data=None, event_meta=None, thread_id=None)`（`seq` 自动 run 内递增）
    - `record_usage(run_id, agent_type, provider, model, input_tokens, output_tokens, cached_tokens=0, reasoning_tokens=0, total_tokens=None, node=None, ttft_ms=None, latency_ms=None, finish_reason=None, thread_id=None)`
    - `record_tool(run_id, agent_type, tool, ok=True, duration_ms=None, args_summary=None, error=None, node=None, thread_id=None)`
    - `finish_run(run_id, status, error=None, error_type=None, node_count=None)`（**完成时把 token 汇总回填到 `agent_request`**）
    - `usage_summary(run_id) -> dict`（聚合 `{input, output, cached, total, calls}`，供 App 结算回传）

---

## Task 1: agent schema + 四表 DDL（幂等）

**Files:**
- Create: `services/agent/src/agent/telemetry/__init__.py`、`telemetry/schema.py`、`tests/test_telemetry_schema.py`

- [ ] **Step 1: 开分支**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec102-observability
mkdir -p services/agent/src/agent/telemetry
```

- [ ] **Step 2: 写 `services/agent/src/agent/telemetry/schema.py`**

```python
from psycopg_pool import ConnectionPool

SETUP_SQL = """
CREATE SCHEMA IF NOT EXISTS agent;

-- thread_id = 会话键（LangGraph 原生：checkpointer 按它续状态）；同一会话可有多个 run。
CREATE TABLE IF NOT EXISTS agent.agent_request (
  run_id        uuid PRIMARY KEY,                  -- 一次执行（App 生成）
  thread_id     text NOT NULL,                     -- 会话/对话（= LangGraph thread_id）
  agent_type    text NOT NULL,
  status        text NOT NULL DEFAULT 'queued',    -- queued/running/succeeded/failed/interrupted/canceled
  file_refs     jsonb,
  input_summary jsonb,
  node_count    int  NOT NULL DEFAULT 0,
  error         text,
  error_type    text,                              -- 失败归类（model_error/timeout/parse_error/...），便于筛
  -- 用量汇总（完成时由 usage_summary 回填，省去列表页 join token_usage）
  input_tokens  bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_tokens bigint NOT NULL DEFAULT 0,
  total_tokens  bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   int
);
CREATE INDEX IF NOT EXISTS agent_request_type_idx   ON agent.agent_request (agent_type, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_request_thread_idx ON agent.agent_request (thread_id);

CREATE TABLE IF NOT EXISTS agent.agent_event_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL,
  thread_id   text,                                -- 会话键（= LangGraph thread_id，便于跨 run 看会话时间线）
  agent_type  text NOT NULL,
  seq         int  NOT NULL,                        -- run 内单调递增序号
  ts          timestamptz NOT NULL DEFAULT now(),
  event_type  text NOT NULL,                        -- run.start/node.start/node.end/tool.call/model.call/sse.chunk/interrupt/resume/error/run.end
  node        text,
  level       text NOT NULL DEFAULT 'info',
  data        jsonb,                                -- 事件载荷（脱敏）
  event_meta  jsonb                                 -- 事件元数据（trace/来源/标签等）
);
CREATE INDEX IF NOT EXISTS agent_event_run_idx    ON agent.agent_event_log (run_id, seq);
CREATE INDEX IF NOT EXISTS agent_event_thread_idx ON agent.agent_event_log (thread_id);
CREATE INDEX IF NOT EXISTS agent_event_type_idx   ON agent.agent_event_log (agent_type, ts DESC);

CREATE TABLE IF NOT EXISTS agent.agent_token_usage (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           uuid NOT NULL,
  thread_id        text,                              -- 便于按会话汇总成本（与其它表对齐）
  agent_type       text NOT NULL,
  ts               timestamptz NOT NULL DEFAULT now(),
  provider         text NOT NULL,                     -- deepseek/qwen/glm
  model            text NOT NULL,
  node             text,
  input_tokens     int NOT NULL DEFAULT 0,
  output_tokens    int NOT NULL DEFAULT 0,
  cached_tokens    int NOT NULL DEFAULT 0,            -- input 中命中提示词缓存的部分（input 的子集，计价更低，非额外相加）
  reasoning_tokens int NOT NULL DEFAULT 0,            -- 推理模型(DeepSeek-R1 等)的思考 token，单列
  total_tokens     int NOT NULL DEFAULT 0,            -- 通常 = input + output（厂商回报，便捷列）
  ttft_ms          int,                               -- 首 token 延迟（流式关键指标）
  latency_ms       int,                               -- 整次调用耗时
  finish_reason    text
);
CREATE INDEX IF NOT EXISTS agent_usage_run_idx    ON agent.agent_token_usage (run_id);
CREATE INDEX IF NOT EXISTS agent_usage_thread_idx ON agent.agent_token_usage (thread_id);
CREATE INDEX IF NOT EXISTS agent_usage_type_idx   ON agent.agent_token_usage (agent_type, ts DESC);

-- 工具调用只落本表（结构化，便于"哪个工具最慢/最易失败"）；event_log 不重复写工具明细。
CREATE TABLE IF NOT EXISTS agent.agent_tool_call (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       uuid NOT NULL,
  thread_id    text,
  agent_type   text NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now(),
  tool         text NOT NULL,
  node         text,
  ok           boolean NOT NULL DEFAULT true,
  duration_ms  int,
  args_summary jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS agent_tool_run_idx  ON agent.agent_tool_call (run_id);
CREATE INDEX IF NOT EXISTS agent_tool_name_idx ON agent.agent_tool_call (agent_type, tool, ts DESC);
"""


def setup_telemetry(pool: ConnectionPool) -> None:
    """幂等建 agent schema 与四表（spec104 迁移时调用一次）。"""
    with pool.connection() as conn:
        conn.execute(SETUP_SQL)
        conn.commit()


if __name__ == "__main__":
    from agent.db import pool

    setup_telemetry(pool)
    print("[telemetry] agent schema 四表已就绪")
```

- [ ] **Step 3: 写失败测试 `services/agent/tests/test_telemetry_schema.py`**

```python
from agent.db import pool
from agent.telemetry.schema import setup_telemetry

EXPECTED = {"agent_request", "agent_event_log", "agent_token_usage", "agent_tool_call"}


def test_setup_creates_four_tables_idempotent():
    setup_telemetry(pool)
    setup_telemetry(pool)  # 二次调用不报错（幂等）
    with pool.connection() as conn:
        rows = conn.execute(
            "select table_name from information_schema.tables where table_schema='agent'"
        ).fetchall()
    names = {r[0] for r in rows}
    assert EXPECTED <= names
```

- [ ] **Step 4: 运行（连真库）**

Run: `cd services/agent && uv run pytest tests/test_telemetry_schema.py -q`
Expected: 1 passed（四表建好且幂等）。

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/telemetry/schema.py services/agent/src/agent/telemetry/__init__.py services/agent/tests/test_telemetry_schema.py
git commit -m "feat(spec102): agent schema 四观测表(带 agent_type, token in/out/cached) + 幂等 setup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Recorder 埋点器 + 集成测试

**Files:**
- Create: `services/agent/src/agent/telemetry/recorder.py`、`services/agent/tests/test_recorder.py`

- [ ] **Step 1: 写失败测试 `services/agent/tests/test_recorder.py`**

```python
import json
import uuid
import pytest
from agent.db import pool
from agent.telemetry.schema import setup_telemetry
from agent.telemetry.recorder import Recorder


@pytest.fixture(scope="module", autouse=True)
def _schema():
    setup_telemetry(pool)


def _cleanup(run_id: str):
    with pool.connection() as conn:
        for t in ("agent_event_log", "agent_token_usage", "agent_tool_call", "agent_request"):
            conn.execute(f"delete from agent.{t} where run_id=%s", (run_id,))
        conn.commit()


def test_full_run_records_and_usage_summary():
    rec = Recorder(pool)
    run_id = str(uuid.uuid4())
    thread_id = str(uuid.uuid4())  # 会话键（与 run_id 不同，体现"会话含多 run"）
    agent_type = "bidding_agent"
    try:
        rec.start_run(run_id, agent_type, thread_id=thread_id, file_refs=["uploads/x/y.pdf"])
        rec.log_event(run_id, agent_type, "node.start", node="read", thread_id=thread_id,
                      event_meta={"trace": "t1"})
        rec.record_usage(run_id, agent_type, provider="deepseek", model="deepseek-chat",
                         input_tokens=1200, output_tokens=300, cached_tokens=800, reasoning_tokens=150,
                         node="read", ttft_ms=120, latency_ms=900, thread_id=thread_id)
        rec.record_tool(run_id, agent_type, tool="parse_docx", ok=True, duration_ms=42, node="read", thread_id=thread_id)
        rec.log_event(run_id, agent_type, "node.end", node="read", thread_id=thread_id)
        rec.finish_run(run_id, status="succeeded", node_count=1)

        # 校验 agent_request（thread_id 会话键 + 完成时回填的用量汇总）
        with pool.connection() as conn:
            row = conn.execute(
                """select status, node_count, agent_type, finished_at, thread_id,
                          input_tokens, output_tokens, cached_tokens, total_tokens
                   from agent.agent_request where run_id=%s""",
                (run_id,),
            ).fetchone()
        assert row[0] == "succeeded" and row[1] == 1 and row[2] == agent_type and row[3] is not None
        assert row[4] == thread_id
        assert (row[5], row[6], row[7], row[8]) == (1200, 300, 800, 1500)  # 回填正确

        # 校验 token_usage 的 LLM 耗时字段
        with pool.connection() as conn:
            u = conn.execute(
                "select ttft_ms, latency_ms, reasoning_tokens from agent.agent_token_usage where run_id=%s", (run_id,)
            ).fetchone()
        assert u == (120, 900, 150)

        # 校验事件：数量 + seq 单调 + event_type + thread_id
        with pool.connection() as conn:
            evs = conn.execute(
                "select seq, event_type, thread_id from agent.agent_event_log where run_id=%s order by seq",
                (run_id,),
            ).fetchall()
        assert [e[0] for e in evs] == [1, 2]
        assert [e[1] for e in evs] == ["node.start", "node.end"]
        assert evs[0][2] == thread_id

        # 校验用量汇总（input/output/cached/total）
        s = rec.usage_summary(run_id)
        assert s["input"] == 1200 and s["output"] == 300 and s["cached"] == 800
        assert s["total"] == 1500 and s["calls"] == 1  # total 缺省 = input+output
    finally:
        _cleanup(run_id)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/agent && uv run pytest tests/test_recorder.py -q`
Expected: FAIL（`Recorder` 不存在）。

- [ ] **Step 3: 写 `services/agent/src/agent/telemetry/recorder.py`**

```python
from __future__ import annotations

import json
from typing import Any
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool


class Recorder:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def start_run(
        self, run_id: str, agent_type: str, thread_id: str,
        file_refs: list[str] | None = None, input_summary: dict[str, Any] | None = None,
    ) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_request
                     (run_id, thread_id, agent_type, status, file_refs, input_summary, started_at)
                   values (%s,%s,%s,'running',%s,%s, now())
                   on conflict (run_id) do update set status='running', started_at=now()""",
                (run_id, thread_id, agent_type,
                 Jsonb(file_refs) if file_refs else None, Jsonb(input_summary) if input_summary else None),
            )
            conn.commit()

    def log_event(
        self, run_id: str, agent_type: str, event_type: str,
        node: str | None = None, level: str = "info",
        data: dict[str, Any] | None = None, event_meta: dict[str, Any] | None = None,
        thread_id: str | None = None,
    ) -> None:
        # seq：run 内单调递增（同一 run 由单 worker 串行写，子查询取 max+1 原子安全）
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_event_log
                     (run_id, thread_id, agent_type, seq, event_type, node, level, data, event_meta)
                   values (%s,%s,%s,
                           (select coalesce(max(seq),0)+1 from agent.agent_event_log where run_id=%s),
                           %s,%s,%s,%s,%s)""",
                (run_id, thread_id, agent_type, run_id,
                 event_type, node, level, Jsonb(data) if data else None, Jsonb(event_meta) if event_meta else None),
            )
            conn.commit()

    def record_usage(
        self, run_id: str, agent_type: str, provider: str, model: str,
        input_tokens: int, output_tokens: int, cached_tokens: int = 0, reasoning_tokens: int = 0,
        total_tokens: int | None = None, node: str | None = None,
        ttft_ms: int | None = None, latency_ms: int | None = None,
        finish_reason: str | None = None, thread_id: str | None = None,
    ) -> None:
        total = total_tokens if total_tokens is not None else input_tokens + output_tokens
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_token_usage
                     (run_id, thread_id, agent_type, provider, model, node,
                      input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, ttft_ms, latency_ms, finish_reason)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (run_id, thread_id, agent_type, provider, model, node,
                 input_tokens, output_tokens, cached_tokens, reasoning_tokens, total, ttft_ms, latency_ms, finish_reason),
            )
            conn.commit()

    def record_tool(
        self, run_id: str, agent_type: str, tool: str, ok: bool = True,
        duration_ms: int | None = None, args_summary: dict[str, Any] | None = None,
        error: str | None = None, node: str | None = None, thread_id: str | None = None,
    ) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_tool_call (run_id, thread_id, agent_type, tool, node, ok, duration_ms, args_summary, error)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (run_id, thread_id, agent_type, tool, node, ok, duration_ms, Jsonb(args_summary) if args_summary else None, error),
            )
            conn.commit()

    def finish_run(
        self, run_id: str, status: str, error: str | None = None,
        error_type: str | None = None, node_count: int | None = None,
    ) -> None:
        # 完成时回填用量汇总到 agent_request（聚合缓存，列表页免 join）
        with self._pool.connection() as conn:
            conn.execute(
                """update agent.agent_request a
                     set status=%s, error=%s, error_type=%s,
                         node_count=coalesce(%s, node_count),
                         finished_at=now(),
                         duration_ms=cast(extract(epoch from (now()-coalesce(started_at, created_at)))*1000 as int),
                         input_tokens  = coalesce((select sum(input_tokens)  from agent.agent_token_usage where run_id=a.run_id),0),
                         output_tokens = coalesce((select sum(output_tokens) from agent.agent_token_usage where run_id=a.run_id),0),
                         cached_tokens = coalesce((select sum(cached_tokens) from agent.agent_token_usage where run_id=a.run_id),0),
                         total_tokens  = coalesce((select sum(total_tokens)  from agent.agent_token_usage where run_id=a.run_id),0)
                   where a.run_id=%s""",
                (status, error, error_type, node_count, run_id),
            )
            conn.commit()

    def usage_summary(self, run_id: str) -> dict[str, int]:
        with self._pool.connection() as conn:
            row = conn.execute(
                """select coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                          coalesce(sum(cached_tokens),0), coalesce(sum(total_tokens),0), count(*)
                   from agent.agent_token_usage where run_id=%s""",
                (run_id,),
            ).fetchone()
        return {"input": row[0], "output": row[1], "cached": row[2], "total": row[3], "calls": row[4]}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd services/agent && uv run pytest tests/test_recorder.py -q`
Expected: 1 passed，自清理。

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/telemetry/recorder.py services/agent/tests/test_recorder.py
git commit -m "feat(spec102): Recorder 埋点器(run/event/usage/tool + usage_summary)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 全量校验 + 合并

- [ ] **Step 1: 全量测试 + lint**

Run: `cd services/agent && uv run pytest -q && uv run ruff check src`
Expected: 全 passed，ruff 无错。

- [ ] **Step 2: 合并**

```bash
git checkout main
git merge --no-ff phase1/spec102-observability -m "merge spec102: 观测与埋点(agent schema 四表 + Recorder)"
git push origin main
```

---

## 验收清单（spec102 完成判据）

- [ ] `agent` schema 含 `agent_request`/`agent_event_log`/`agent_token_usage`/`agent_tool_call` 四表，`setup_telemetry` 幂等。
- [ ] **每张表都有 `agent_type`**；`agent_token_usage` 记 **input/output/cached/reasoning/total** token + **`ttft_ms`(首token) / `latency_ms`(LLM 调用耗时)**。
- [ ] `agent_request` 完成时回填 token 汇总（input/output/cached/total）+ `error_type`；列表页查 run 带成本/耗时免 join。
- [ ] 工具调用只落 `agent_tool_call`（结构化），`event_log` 不重复写工具明细（无双写冗余）。
- [ ] `agent_event_log` 含 `event_type`、`seq`(run 内单调递增)、`thread_id`、`data`、`event_meta`；按 `(run_id, seq)` 有序。
- [ ] `agent_request` 含 `thread_id`(会话键)，可由 run 反查会话；`agent_event_log` 可按 `thread_id` 看跨 run 会话时间线。
- [ ] 只用 `run_id` + `thread_id` 两个 ID（无 `conversation_id`/`request_id`）。
- [ ] `Recorder` 全方法写入正确；`usage_summary` 按 run 聚合 input/output/cached/total/calls。
- [ ] `agent_request` 生命周期：start(running) → finish(succeeded/failed，落 duration_ms)。
- [ ] 表落 `agent` schema，与 `langgraph`/`public` 分离；不碰钱。
- [ ] `uv run pytest` + `ruff` 全绿。
