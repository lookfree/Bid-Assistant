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
    meta = {"agent_type": agent_type, "thread_id": tid, "input": input,
            "model": model, "user_id": user_id}
    # 顺序铁律:runmeta 必须先写、消息后入队——否则 worker 可能在 runmeta 落地前就消费到消息、
    # 读到空 runmeta 误判「missing」失败(网络抖动放大这个窗口,实测连环失败)。
    r.set(runmeta_key(run_id), json.dumps(meta), ex=86400)
    entry_id = r.xadd(stream_key(), {"run_id": run_id})   # 入队:此刻 runmeta 必已就绪
    # 入队后回填 entry_id(供 queued 清道夫和消费组 last-delivered 游标比对,判定「已投递却卡住」)。
    # worker 读 runmeta 只需 agent_type 等,不依赖 entry_id;清道夫读到还没回填的空 entry_id → 保守不回收。
    eid = entry_id.decode() if isinstance(entry_id, bytes) else str(entry_id)
    r.set(runmeta_key(run_id), json.dumps({**meta, "entry_id": eid}), ex=86400)
    return run_id
