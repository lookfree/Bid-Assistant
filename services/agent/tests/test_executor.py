import asyncio
import json

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.dispatch import create_run
from agent.runtime.executor import process_run
from agent.runtime.channels import progress_stream, result_key


def _cleanup(run_id):
    with get_pool().connection() as conn:
        for t in ("agent_event_log", "agent_token_usage", "agent_tool_call", "agent_request"):
            conn.execute(f"delete from agent.{t} where run_id=%s", (run_id,))
        conn.commit()
    r = get_redis()
    r.delete(result_key(run_id))
    r.delete(progress_stream(run_id))


def test_create_and_process_run_end_to_end():
    r = get_redis()
    run_id = create_run("dummy", {"text": "ok"})
    try:
        asyncio.run(process_run(run_id))

        # 状态 = succeeded，结果落 Redis
        with get_pool().connection() as conn:
            status = conn.execute("select status from agent.agent_request where run_id=%s", (run_id,)).fetchone()[0]
        assert status == "succeeded"
        assert json.loads(r.get(result_key(run_id)))["echo"] == "ok"

        # 进度事件落 Stream（可回放）：run 跑完后仍能从头 xrange 拿全过程——正是 pub/sub 做不到的"晚订阅"。
        evs = r.xrange(progress_stream(run_id))
        types = [json.loads(f["event"])["type"] for _id, f in evs]
        assert "run.start" in types and "chunk" in types and "run.end" in types
    finally:
        _cleanup(run_id)
