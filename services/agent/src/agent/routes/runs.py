import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime.dispatch import create_run
from agent.runtime.channels import progress_stream, result_key

router = APIRouter()

_TERMINAL = {"succeeded", "failed", "interrupted", "canceled"}


def _is_terminal(run_id: str) -> bool:
    with get_pool().connection() as conn:
        row = conn.execute("select status from agent.agent_request where run_id=%s", (run_id,)).fetchone()
    return bool(row) and row[0] in _TERMINAL


class RunModelOverride(BaseModel):
    provider: str | None = None
    model: str | None = None
    fallbacks: str | None = None
    params: dict | None = None  # spec319：主模型采样参数 {temperature,max_tokens,top_p}；缺省继承 env
    # spec319.1：结构化模型链，每项 {provider,model,base_url?,api_key?}，可携带自建端点凭据；
    # 未声明则 pydantic 会丢弃 App 下发的 chain（同 spec319 params 漏字段的坑）。
    chain: list[dict] | None = None


class CreateRunBody(BaseModel):
    input: dict
    thread_id: str | None = None
    file_refs: list[str] | None = None
    model: RunModelOverride | None = None  # spec311：App 下发的模型选择，覆盖 env 默认
    user_id: str | None = None  # 资料库 RAG 属主（spec316 A2）；App 每 run 透传，agent 服务对钱无感知


@router.post("/agents/{agent_type}/runs")
async def create(agent_type: str, body: CreateRunBody):
    model = body.model.model_dump() if body.model else None
    run_id = create_run(agent_type, body.input, body.thread_id, body.file_refs, model, body.user_id)
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
        key = progress_stream(run_id)
        last_id = "0"  # 从头读：晚订阅/断线重连也能回放全过程（Stream 持久，pub/sub 做不到）
        r = get_redis()
        idle = 0
        while True:
            # 阻塞读丢线程池，别卡事件循环（否则并发 SSE 客户端会串行）。
            resp = await asyncio.to_thread(r.xread, {key: last_id}, count=100, block=1000)
            if not resp:
                # 无新事件：每 ~5s 才查一次 DB 终态（兜底 run.end 缺失，如 worker 硬崩），别每秒打 PG。
                idle += 1
                if idle >= 5 and await asyncio.to_thread(_is_terminal, run_id):
                    break
                continue
            idle = 0
            for _k, entries in resp:
                for entry_id, fields in entries:
                    last_id = entry_id
                    data = fields["event"]
                    ev = json.loads(data)
                    yield {"event": ev["type"], "data": data}
                    if ev["type"] == "run.end":
                        return

    return EventSourceResponse(gen())
