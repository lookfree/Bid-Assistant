# spec104 · Run 运行时 + 统一契约 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭好智能体统一运行时：`AGENT_REGISTRY`（按 `agent_type` 注册）、统一 run 契约（`POST /agents/{type}/runs`、`GET /runs/{id}`、`GET /runs/{id}/stream` SSE）、**Redis Stream 派发 + Worker 消费**（§4.6）、**LangGraph `PostgresSaver` checkpointer + `setup()` 建 `langgraph` 四表**（§4.7），事件经 spec102 `Recorder` 落库，完成时回传用量给 App。用一个 **dummy agent** 把端到端机器跑通（真实「读标」在 spec106 注册进来）。

**Architecture:** api 角色建 run（落 `agent_request=queued` + `XADD` 到 Stream）并以 SSE 订阅 Redis pub/sub 中继进度；worker 角色消费 Stream、执行 `process_run`（跑 agent → 逐块 publish + 埋点 → 结果存 Redis → finish + 用量回调）。checkpointer 用 `AsyncPostgresSaver`（`search_path=langgraph`），供 spec106 的真实图续状态/HITL。

**Tech Stack:** FastAPI、sse-starlette、langgraph、langgraph-checkpoint-postgres、redis-py、httpx、pytest（+pytest-asyncio）。

## Global Constraints

见 `spec100-index.md`。本 spec 关键约束：
- 统一契约对所有 `agent_type` 共用（§4.3）；agent 对业务无知（只认 input/agent_type/文件引用）。
- 长任务异步：api 不阻塞执行，worker 跑；进度走 SSE（§3.2 铁律③）。
- checkpointer 落 bidsaas `langgraph` schema（连接 `search_path=langgraph,public`）；`setup()` 当迁移跑一次。
- 队列/频道前缀 `bid:agent:`；用量回调只报 usage，不碰钱（§3.2 铁律①）。
- 在 `main` 上先开分支；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
services/agent/
├── pyproject.toml                         # 改：+ langgraph / langgraph-checkpoint-postgres / sse-starlette / httpx
├── src/agent/
│   ├── config.py                          # 改：+ app_callback_url（用量回调）
│   ├── checkpointer.py                    # 新：AsyncPostgresSaver(search_path=langgraph) + setup
│   ├── migrate.py                         # 新：一次性迁移（telemetry + checkpointer setup）
│   ├── runtime/
│   │   ├── __init__.py
│   │   ├── registry.py                    # 新：AGENT_REGISTRY + AgentProtocol
│   │   ├── dummy_agent.py                 # 新：echo dummy（astream）
│   │   ├── dispatch.py                    # 新：create_run(入队) + 读 run 元数据
│   │   ├── executor.py                    # 新：process_run(执行+publish+埋点+回调)
│   │   └── channels.py                    # 新：pub/sub 频道 + Redis Stream 键
│   ├── routes/runs.py                     # 新：/agents/{type}/runs、/runs/{id}、/runs/{id}/stream
│   ├── app.py                             # 改：挂 runs 路由
│   └── main_worker.py                     # 改：消费 Stream → process_run
└── tests/
    ├── test_executor.py                   # 新：process_run 端到端(真 DB/Redis)
    └── test_runs_api.py                   # 新：建 run + 状态 + SSE 中继
```

---

## Interfaces（本 spec 对外产出，供 spec106/107 依赖）

- Produces：
  - `AGENT_REGISTRY: dict[str, AgentFactory]`；`register(agent_type, factory)`；`AgentProtocol.astream(input, ctx) -> AsyncIterator[dict]`（事件 `{type, data, node?}`）。
  - `RunContext`：`run_id, agent_type, thread_id, recorder, gateway, redis`（传给 agent）。
  - `create_run(agent_type, input, thread_id=None, file_refs=None) -> run_id`（入队）。
  - `process_run(run_id)`（worker 执行单个 run）。
  - `get_checkpointer()`（供 spec106 真实图编译）。
  - HTTP 契约（§4.3）：
    - `POST /agents/{agent_type}/runs` body `{ input, thread_id?, file_refs? }` → `200 { run_id }`
    - `GET /runs/{run_id}` → `200 { run_id, status, agent_type, tokens:{...}, duration_ms, result? }`
    - `GET /runs/{run_id}/stream` → `text/event-stream`（事件：`run.start`/`chunk`/`...`/`run.end`）

---

## Task 1: 依赖 + checkpointer + 迁移入口

**Files:**
- Modify: `pyproject.toml`、`src/agent/config.py`
- Create: `src/agent/checkpointer.py`、`src/agent/migrate.py`、`tests/test_migrate.py`

- [ ] **Step 1: 开分支 + 装依赖**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec104-runtime
cd services/agent && uv add langgraph langgraph-checkpoint-postgres sse-starlette httpx && mkdir -p src/agent/runtime
```

- [ ] **Step 2: `config.py` 加用量回调地址**

```python
    app_callback_url: str | None = None   # App 的用量回调端点；None 则跳过（dummy/dev）
```

- [ ] **Step 3: 写 `src/agent/checkpointer.py`**

```python
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from agent.config import settings

# 让 checkpointer 四表落 langgraph schema：连接 options 设 search_path
_CONNINFO = settings.database_url + ("&" if "?" in settings.database_url else "?") + "options=-csearch_path%3Dlanggraph,public"

_saver: AsyncPostgresSaver | None = None


async def get_checkpointer() -> AsyncPostgresSaver:
    global _saver
    if _saver is None:
        _saver = AsyncPostgresSaver.from_conn_string(_CONNINFO)
        await _saver.__aenter__()  # 建立连接池
    return _saver


async def setup_checkpointer() -> None:
    """建 langgraph 四表（checkpoints/checkpoint_blobs/checkpoint_writes/checkpoint_migrations），幂等。"""
    cp = await get_checkpointer()
    await cp.setup()
```

> 注：先确保 `langgraph` schema 存在（spec102 `setup_telemetry` 会建 `agent` schema；checkpointer 落 `langgraph` schema —— 在 `migrate.py` 里先 `CREATE SCHEMA IF NOT EXISTS langgraph` 再 setup）。`AsyncPostgresSaver` 的 `setup()` 在 `search_path` 首位（langgraph）建四表；落地时验证该版本是否尊重 search_path，否则退落 public（§4.7）。

- [ ] **Step 4: 写 `src/agent/migrate.py`（一次性迁移：建 schema + 两套表）**

```python
import asyncio
from agent.db import pool
from agent.telemetry.schema import setup_telemetry
from agent.checkpointer import setup_checkpointer


def _ensure_schemas() -> None:
    with pool.connection() as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS langgraph")
        conn.commit()


async def main() -> None:
    _ensure_schemas()
    setup_telemetry(pool)             # agent schema 观测四表
    await setup_checkpointer()         # langgraph schema checkpointer 四表
    print("[migrate] agent + langgraph 表已就绪")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 5: 写测试 `tests/test_migrate.py`（连真库，验证两套表）**

```python
import asyncio
from agent.db import pool
from agent.migrate import main as migrate_main


def test_migrate_creates_both_schemas():
    asyncio.run(migrate_main())
    with pool.connection() as conn:
        agent_n = conn.execute(
            "select count(*) from information_schema.tables where table_schema='agent'"
        ).fetchone()[0]
        lg = conn.execute(
            "select count(*) from information_schema.tables where table_schema='langgraph' and table_name like 'checkpoint%'"
        ).fetchone()[0]
    assert agent_n >= 4 and lg >= 3   # checkpoints/blobs/writes(+migrations)
```

- [ ] **Step 6: 运行（连 bidsaas）+ 提交**

Run: `cd services/agent && uv run pytest tests/test_migrate.py -q`
Expected: passed（agent 四表 + langgraph checkpoint 表均就绪）。

```bash
git add services/agent/pyproject.toml services/agent/src/agent/config.py services/agent/src/agent/checkpointer.py services/agent/src/agent/migrate.py services/agent/tests/test_migrate.py
git commit -m "feat(spec104): checkpointer(search_path=langgraph) + 一次性迁移(telemetry+checkpointer)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: AgentRegistry + dummy agent

**Files:**
- Create: `src/agent/runtime/__init__.py`、`runtime/registry.py`、`runtime/dummy_agent.py`、`runtime/channels.py`、`tests/test_dummy_agent.py`

- [ ] **Step 1: 写 `src/agent/runtime/channels.py`**

```python
from agent.config import settings

# 注：redis 客户端已带 keyPrefix? Python redis-py 无内建前缀，这里显式拼前缀
def stream_key() -> str: return f"{settings.redis_prefix}runs"           # Redis Stream：待执行 run
def run_channel(run_id: str) -> str: return f"{settings.redis_prefix}run:{run_id}"  # pub/sub：进度
def runmeta_key(run_id: str) -> str: return f"{settings.redis_prefix}runmeta:{run_id}"
def result_key(run_id: str) -> str: return f"{settings.redis_prefix}result:{run_id}"
```

- [ ] **Step 2: 写 `src/agent/runtime/registry.py`**

```python
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Protocol


@dataclass
class RunContext:
    run_id: str
    agent_type: str
    thread_id: str
    recorder: Any
    gateway: Any = None
    redis: Any = None


class AgentProtocol(Protocol):
    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:  # 事件 {type, data, node?}
        ...


AgentFactory = Callable[[], AgentProtocol]
AGENT_REGISTRY: dict[str, AgentFactory] = {}


def register(agent_type: str, factory: AgentFactory) -> None:
    AGENT_REGISTRY[agent_type] = factory


def get_agent(agent_type: str) -> AgentProtocol:
    if agent_type not in AGENT_REGISTRY:
        raise KeyError(f"未注册的 agent_type: {agent_type}")
    return AGENT_REGISTRY[agent_type]()
```

- [ ] **Step 3: 写 `src/agent/runtime/dummy_agent.py`（echo，验证管线）**

```python
from typing import AsyncIterator
from agent.runtime.registry import RunContext, register


class DummyAgent:
    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        text = str(input.get("text", ""))
        yield {"type": "node.start", "node": "echo"}
        for i, ch in enumerate(text):
            yield {"type": "chunk", "node": "echo", "data": {"delta": ch, "i": i}}
        yield {"type": "node.end", "node": "echo", "data": {"result": {"echo": text, "len": len(text)}}}


register("dummy", lambda: DummyAgent())
```

- [ ] **Step 4: 写测试 `tests/test_dummy_agent.py`**

```python
import asyncio
from agent.runtime.registry import get_agent, RunContext
import agent.runtime.dummy_agent  # noqa: F401 触发注册


def test_dummy_streams_chunks_and_result():
    agent = get_agent("dummy")
    ctx = RunContext(run_id="r", agent_type="dummy", thread_id="t", recorder=None)

    async def run():
        return [ev async for ev in agent.astream({"text": "hi"}, ctx)]

    evs = asyncio.run(run())
    assert evs[0]["type"] == "node.start"
    chunks = [e for e in evs if e["type"] == "chunk"]
    assert "".join(c["data"]["delta"] for c in chunks) == "hi"
    assert evs[-1]["data"]["result"] == {"echo": "hi", "len": 2}
```

- [ ] **Step 5: 运行 + 提交**

Run: `cd services/agent && uv run pytest tests/test_dummy_agent.py -q`
Expected: passed。

```bash
git add services/agent/src/agent/runtime services/agent/tests/test_dummy_agent.py
git commit -m "feat(spec104): AgentRegistry + AgentProtocol + dummy agent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 派发(入队) + process_run(执行) + 集成测试

**Files:**
- Create: `src/agent/runtime/dispatch.py`、`runtime/executor.py`、`tests/test_executor.py`

**Interfaces:**
- Produces: `create_run(...)`、`process_run(run_id)`。

- [ ] **Step 1: 写 `src/agent/runtime/dispatch.py`**

```python
import json
import uuid
from agent.db import pool
from agent.redis_client import get_redis
from agent.runtime.channels import stream_key, runmeta_key


def create_run(agent_type: str, input: dict, thread_id: str | None = None, file_refs: list[str] | None = None) -> str:
    run_id = str(uuid.uuid4())
    tid = thread_id or run_id
    # 落 queued（GET 立即可查）
    with pool.connection() as conn:
        conn.execute(
            "insert into agent.agent_request (run_id, thread_id, agent_type, status, file_refs) values (%s,%s,%s,'queued',%s)",
            (run_id, tid, agent_type, json.dumps(file_refs) if file_refs else None),
        )
        conn.commit()
    r = get_redis()
    r.set(runmeta_key(run_id), json.dumps({"agent_type": agent_type, "thread_id": tid, "input": input}), ex=86400)
    r.xadd(stream_key(), {"run_id": run_id})
    return run_id
```

- [ ] **Step 2: 写 `src/agent/runtime/executor.py`**

```python
from __future__ import annotations

import json
import httpx
from agent.config import settings
from agent.db import pool
from agent.redis_client import get_redis
from agent.telemetry.recorder import Recorder
from agent.runtime.channels import run_channel, runmeta_key, result_key
from agent.runtime.registry import get_agent, RunContext
import agent.runtime.dummy_agent  # noqa: F401 确保 dummy 注册

_recorder = Recorder(pool)


def _publish(r, run_id: str, event: dict) -> None:
    r.publish(run_channel(run_id), json.dumps(event))


async def process_run(run_id: str) -> None:
    r = get_redis()
    meta = json.loads(r.get(runmeta_key(run_id)) or "{}")
    agent_type, thread_id, input = meta.get("agent_type"), meta.get("thread_id", run_id), meta.get("input", {})

    _recorder.start_run(run_id, agent_type, thread_id)
    _recorder.log_event(run_id, agent_type, "run.start", thread_id=thread_id)
    _publish(r, run_id, {"type": "run.start"})

    ctx = RunContext(run_id=run_id, agent_type=agent_type, thread_id=thread_id, recorder=_recorder, redis=r)
    result = None
    nodes = set()
    try:
        agent = get_agent(agent_type)
        async for ev in agent.astream(input, ctx):
            if ev.get("node"):
                nodes.add(ev["node"])
            if ev["type"] in ("node.start", "node.end", "error"):
                _recorder.log_event(run_id, agent_type, ev["type"], node=ev.get("node"),
                                    data=ev.get("data"), thread_id=thread_id)
            if ev["type"] == "node.end" and isinstance(ev.get("data"), dict) and "result" in ev["data"]:
                result = ev["data"]["result"]
            _publish(r, run_id, ev)  # 全部事件推 SSE

        r.set(result_key(run_id), json.dumps(result), ex=86400)
        _recorder.finish_run(run_id, status="succeeded", node_count=len(nodes))
        _publish(r, run_id, {"type": "run.end", "data": {"status": "succeeded"}})
        await _callback(run_id, agent_type, "succeeded")
    except Exception as e:  # noqa: BLE001
        _recorder.log_event(run_id, agent_type, "error", level="error", data={"error": str(e)}, thread_id=thread_id)
        _recorder.finish_run(run_id, status="failed", error=str(e), error_type=type(e).__name__)
        _publish(r, run_id, {"type": "run.end", "data": {"status": "failed", "error": str(e)}})
        await _callback(run_id, agent_type, "failed")


async def _callback(run_id: str, agent_type: str, status: str) -> None:
    if not settings.app_callback_url:
        return
    usage = _recorder.usage_summary(run_id)
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(settings.app_callback_url, json={"run_id": run_id, "agent_type": agent_type,
                                                          "status": status, "usage": usage})
    except Exception:
        pass  # 回调失败不阻断；App 侧另有对账
```

- [ ] **Step 3: 写集成测试 `tests/test_executor.py`（真 DB/Redis）**

```python
import asyncio
import json
from agent.db import pool
from agent.redis_client import get_redis
from agent.runtime.dispatch import create_run
from agent.runtime.executor import process_run
from agent.runtime.channels import run_channel, result_key


def _cleanup(run_id):
    with pool.connection() as conn:
        for t in ("agent_event_log", "agent_token_usage", "agent_tool_call", "agent_request"):
            conn.execute(f"delete from agent.{t} where run_id=%s", (run_id,))
        conn.commit()
    get_redis().delete(result_key(run_id))


def test_create_and_process_run_end_to_end():
    r = get_redis()
    run_id = create_run("dummy", {"text": "ok"})
    try:
        # 订阅频道收集事件
        ps = r.pubsub()
        ps.subscribe(run_channel(run_id))

        asyncio.run(process_run(run_id))

        # 状态 = succeeded，结果落 Redis
        with pool.connection() as conn:
            status = conn.execute("select status from agent.agent_request where run_id=%s", (run_id,)).fetchone()[0]
        assert status == "succeeded"
        assert json.loads(r.get(result_key(run_id)))["echo"] == "ok"

        # 收到的事件含 run.start / chunk / run.end
        types = []
        for _ in range(30):
            m = ps.get_message(timeout=0.2)
            if m and m["type"] == "message":
                types.append(json.loads(m["data"])["type"])
        ps.close()
        assert "run.start" in types and "chunk" in types and "run.end" in types
    finally:
        _cleanup(run_id)
```

- [ ] **Step 4: 运行 + 提交**

Run: `cd services/agent && uv run pytest tests/test_executor.py -q`
Expected: passed（建 run→执行→状态 succeeded→结果落 Redis→事件流齐）。

```bash
git add services/agent/src/agent/runtime/dispatch.py services/agent/src/agent/runtime/executor.py services/agent/tests/test_executor.py
git commit -m "feat(spec104): create_run 入队 + process_run 执行/埋点/回调 + 集成测试

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: run API（创建 / 状态 / SSE）

**Files:**
- Create: `src/agent/routes/runs.py`、`tests/test_runs_api.py`
- Modify: `src/agent/app.py`

- [ ] **Step 1: 写 `src/agent/routes/runs.py`**

```python
import asyncio
import json
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel
from agent.db import pool
from agent.redis_client import get_redis
from agent.runtime.dispatch import create_run
from agent.runtime.channels import run_channel, result_key

router = APIRouter()


class CreateRunBody(BaseModel):
    input: dict
    thread_id: str | None = None
    file_refs: list[str] | None = None


@router.post("/agents/{agent_type}/runs")
async def create(agent_type: str, body: CreateRunBody):
    run_id = create_run(agent_type, body.input, body.thread_id, body.file_refs)
    return {"run_id": run_id}


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    with pool.connection() as conn:
        row = conn.execute(
            """select status, agent_type, input_tokens, output_tokens, cached_tokens, total_tokens, duration_ms
               from agent.agent_request where run_id=%s""", (run_id,)).fetchone()
    if not row:
        return JSONResponse({"error": "not_found"}, status_code=404)
    result = get_redis().get(result_key(run_id))
    return {
        "run_id": run_id, "status": row[0], "agent_type": row[1],
        "tokens": {"input": row[2], "output": row[3], "cached": row[4], "total": row[5]},
        "duration_ms": row[6], "result": json.loads(result) if result else None,
    }


@router.get("/runs/{run_id}/stream")
async def stream(run_id: str):
    async def gen():
        ps = get_redis().pubsub()
        ps.subscribe(run_channel(run_id))
        try:
            while True:
                m = ps.get_message(timeout=1.0)
                if m and m["type"] == "message":
                    ev = json.loads(m["data"])
                    yield {"event": ev["type"], "data": m["data"]}
                    if ev["type"] == "run.end":
                        break
                await asyncio.sleep(0)
        finally:
            ps.close()

    return EventSourceResponse(gen())
```

> SSE 用 Redis pub/sub 中继：worker 在另一进程 publish，api 进程订阅转发。生产多副本下，订阅任意 api 实例都能收到（pub/sub 广播）。

- [ ] **Step 2: `app.py` 挂 runs 路由**

```python
from agent.routes.runs import router as runs_router
# create_app() 内：
    app.include_router(runs_router)
```

- [ ] **Step 3: 写测试 `tests/test_runs_api.py`**

```python
import asyncio
import json
from fastapi.testclient import TestClient
from agent.app import create_app
from agent.runtime.executor import process_run
from agent.db import pool
from agent.redis_client import get_redis
from agent.runtime.channels import result_key


def _cleanup(run_id):
    with pool.connection() as conn:
        for t in ("agent_event_log", "agent_token_usage", "agent_tool_call", "agent_request"):
            conn.execute(f"delete from agent.{t} where run_id=%s", (run_id,))
        conn.commit()
    get_redis().delete(result_key(run_id))


def test_create_then_status():
    client = TestClient(create_app())
    run_id = client.post("/agents/dummy/runs", json={"input": {"text": "ab"}}).json()["run_id"]
    try:
        # 刚建：queued
        assert client.get(f"/runs/{run_id}").json()["status"] == "queued"
        # 执行后：succeeded + 结果
        asyncio.run(process_run(run_id))
        body = client.get(f"/runs/{run_id}").json()
        assert body["status"] == "succeeded"
        assert body["result"]["echo"] == "ab"
    finally:
        _cleanup(run_id)

    # 未知 run -> 404
    assert client.get("/runs/00000000-0000-0000-0000-000000000000").status_code == 404
```

- [ ] **Step 4: 运行 + 提交**

Run: `cd services/agent && uv run pytest tests/test_runs_api.py -q`
Expected: passed。

```bash
git add services/agent/src/agent/routes/runs.py services/agent/src/agent/app.py services/agent/tests/test_runs_api.py
git commit -m "feat(spec104): run API(创建/状态/SSE 中继)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Worker 消费循环 + 端到端冒烟 + 合并

**Files:**
- Modify: `src/agent/main_worker.py`

- [ ] **Step 1: 改 `src/agent/main_worker.py`（消费 Stream → process_run）**

```python
import asyncio
from agent.config import settings
from agent.redis_client import get_redis
from agent.runtime.channels import stream_key
from agent.runtime.executor import process_run


async def run_loop() -> None:
    r = get_redis()
    last_id = "$"  # 只读新消息（生产用 consumer group，本 spec 先简化）
    print(f"[worker] consuming {stream_key()} ...")
    while True:
        resp = r.xread({stream_key(): last_id}, count=1, block=5000)
        if not resp:
            continue
        for _stream, entries in resp:
            for entry_id, fields in entries:
                last_id = entry_id
                run_id = fields.get("run_id")
                if run_id:
                    try:
                        await process_run(run_id)
                    except Exception as e:  # noqa: BLE001
                        print(f"[worker] run {run_id} failed: {e}")


def main() -> None:
    asyncio.run(run_loop())


if __name__ == "__main__":
    main()
```

> 本 spec 用简化 `XREAD $`（只收新消息）。生产用 **consumer group**（`XREADGROUP` + ack）保证宕机不丢、可水平扩 worker（§4.6 竞争消费）——留 spec107/加固。

- [ ] **Step 2: 端到端冒烟（两个进程）**

```bash
cd services/agent && uv run python -m agent.migrate          # 一次性建表
# 终端1：worker
cd services/agent && uv run python -m agent.main_worker
# 终端2：api
cd services/agent && uv run uvicorn agent.main_api:app --port 8090
# 终端3：建 run + 看 SSE
curl -s -XPOST localhost:8090/agents/dummy/runs -H 'content-type: application/json' -d '{"input":{"text":"hello"}}'
curl -N localhost:8090/runs/<run_id>/stream    # 看到 run.start/chunk.../run.end
curl -s localhost:8090/runs/<run_id>           # status=succeeded, result.echo=hello
```
Expected: worker 消费并执行；SSE 实时输出逐字 chunk；状态 succeeded。
> 清理：删 `agent.*` 中该 run_id 行 + Redis `bid:agent:*:<run_id>`。

- [ ] **Step 3: 全量测试 + lint + 合并**

Run: `cd services/agent && uv run pytest -q && uv run ruff check src`
Expected: 全 passed，ruff 无错。

```bash
git add services/agent/src/agent/main_worker.py
git commit -m "feat(spec104): worker 消费循环 + 端到端跑通(dummy)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase1/spec104-runtime -m "merge spec104: Run 运行时 + 统一契约"
git push origin main
```

---

## 验收清单（spec104 完成判据）

- [ ] `migrate` 建好 `agent`(观测四表) + `langgraph`(checkpointer 四表) 两套；`setup` 幂等。
- [ ] `AGENT_REGISTRY` 可注册/取用；dummy agent astream 逐块产出。
- [ ] `POST /agents/{type}/runs` 落 `queued` + 入队；`GET /runs/{id}` 返回状态/tokens/result；未知 run 404。
- [ ] `process_run` 执行 dummy：埋点(run.start/node/run.end) + 逐块 publish + 结果落 Redis + finish(succeeded) + 用量回调(配置时)。
- [ ] `GET /runs/{id}/stream` SSE 中继 pub/sub，收到 run.start→chunk→run.end。
- [ ] worker 消费 Stream → process_run，端到端 dummy 跑通。
- [ ] `get_checkpointer()` 就绪（供 spec106 真实图续状态/HITL）。
- [ ] `uv run pytest` + `ruff` 全绿。
