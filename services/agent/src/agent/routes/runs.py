import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel

from agent.db import get_pool
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
    with get_pool().connection() as conn:
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
