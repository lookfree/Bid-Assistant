import pytest

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.channels import result_key, progress_stream


@pytest.fixture
def cleanup_run():
    """注册 run_id，测试结束统一清 agent.* 四表 + Redis result/progress 键（表清单一处维护）。"""
    ids: list[str] = []

    def _register(run_id: str) -> str:
        ids.append(run_id)
        return run_id

    yield _register

    for run_id in ids:
        with get_pool().connection() as conn:
            for t in ("agent_event_log", "agent_token_usage", "agent_tool_call", "agent_request"):
                conn.execute(f"delete from agent.{t} where run_id=%s", (run_id,))
            conn.commit()
        r = get_redis()
        r.delete(result_key(run_id))
        r.delete(progress_stream(run_id))
