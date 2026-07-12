import json
import uuid

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.channels import stream_key, runmeta_key


def create_run(agent_type: str, input: dict, thread_id: str | None = None,
                file_refs: list[str] | None = None, model: dict | None = None,
                user_id: str | None = None) -> str:
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
    entry_id = r.xadd(stream_key(), {"run_id": run_id})
    # entry_id 存进 runmeta：queued 清道夫据此和消费组 last-delivered 游标比对——
    # 只回收「已投递却卡住」的(entry_id ≤ 游标),不误杀「尚未投递、只是排队等消费」的(entry_id > 游标)。
    eid = entry_id.decode() if isinstance(entry_id, bytes) else str(entry_id)
    r.set(runmeta_key(run_id), json.dumps(
        {"agent_type": agent_type, "thread_id": tid, "input": input, "model": model,
         "user_id": user_id, "entry_id": eid}), ex=86400)
    return run_id
