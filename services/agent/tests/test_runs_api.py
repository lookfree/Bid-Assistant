import asyncio

from fastapi.testclient import TestClient

from agent.app import create_app
from agent.runtime.executor import process_run
from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.channels import progress_stream, result_key


def _cleanup(run_id):
    with get_pool().connection() as conn:
        for t in ("agent_event_log", "agent_token_usage", "agent_tool_call", "agent_request"):
            conn.execute(f"delete from agent.{t} where run_id=%s", (run_id,))
        conn.commit()
    r = get_redis()
    r.delete(result_key(run_id))
    r.delete(progress_stream(run_id))


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


def test_stream_replays_already_finished_run():
    """晚订阅：run 先跑完，再打开 SSE 应从 Stream 回放全过程并正常结束（不永挂）。"""
    client = TestClient(create_app())
    run_id = client.post("/agents/dummy/runs", json={"input": {"text": "xy"}}).json()["run_id"]
    try:
        asyncio.run(process_run(run_id))  # 先跑完
        events = []
        with client.stream("GET", f"/runs/{run_id}/stream") as resp:
            for line in resp.iter_lines():
                if line.startswith("event:"):
                    events.append(line.split(":", 1)[1].strip())
        assert "run.start" in events and "run.end" in events   # 回放到全过程且正常收尾
    finally:
        _cleanup(run_id)
