import json
import uuid

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.channels import stream_key, runmeta_key


def create_run(agent_type: str, input: dict, thread_id: str | None = None,
                file_refs: list[str] | None = None, model: dict | None = None) -> str:
    run_id = str(uuid.uuid4())
    tid = thread_id or run_id
    # 落 queued（GET 立即可查）
    with get_pool().connection() as conn:
        conn.execute(
            "insert into agent.agent_request (run_id, thread_id, agent_type, status, file_refs) values (%s,%s,%s,'queued',%s)",
            (run_id, tid, agent_type, json.dumps(file_refs) if file_refs else None),
        )
        conn.commit()
    r = get_redis()
    r.set(runmeta_key(run_id), json.dumps(
        {"agent_type": agent_type, "thread_id": tid, "input": input, "model": model}), ex=86400)
    r.xadd(stream_key(), {"run_id": run_id})
    return run_id
