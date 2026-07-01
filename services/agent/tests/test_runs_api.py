import asyncio

from fastapi.testclient import TestClient

from agent.app import create_app
from agent.runtime.executor import process_run
from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.channels import result_key


def _cleanup(run_id):
    with get_pool().connection() as conn:
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
