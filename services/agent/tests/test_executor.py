import asyncio
import json

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.dispatch import create_run
from agent.runtime.executor import process_run
from agent.runtime.channels import run_channel, result_key


def _cleanup(run_id):
    with get_pool().connection() as conn:
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
        with get_pool().connection() as conn:
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
