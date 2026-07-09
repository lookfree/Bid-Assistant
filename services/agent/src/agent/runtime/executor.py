from __future__ import annotations

import asyncio
import json

import httpx

from agent.config import settings
from agent.db import get_pool
from agent.redis_client import get_redis
from agent.telemetry.recorder import Recorder
from agent.models.gateway import ModelGateway, model_override_to_settings
from agent.runtime.channels import progress_stream, runmeta_key, result_key
from agent.runtime.registry import get_agent, RunContext
import agent.runtime.dummy_agent  # noqa: F401 确保 dummy 注册
import agent.agents.bidding_agent  # noqa: F401 注册 agent_type="bidding_agent"

_gateway = ModelGateway(settings)          # 无副作用
_recorder: Recorder | None = None           # 惰性：import 期不连库


def _rec() -> Recorder:
    global _recorder
    if _recorder is None:
        _recorder = Recorder(get_pool())
    return _recorder


def _publish(r, run_id: str, event: dict) -> None:
    # 进度落 Redis Stream（持久、可回放）：晚订阅/断线重连的 SSE 客户端能从头 XREAD 拿全过程。
    # xadd + expire(24h，随 result 过期防堆积) 用 pipeline 合成一次往返。
    key = progress_stream(run_id)
    pipe = r.pipeline()
    pipe.xadd(key, {"event": json.dumps(event)})
    pipe.expire(key, 86400)
    pipe.execute()


async def _apublish(r, run_id: str, event: dict) -> None:
    # _publish 是同步 Redis 网络 IO；卸载到线程池，避免多 run 并发时占住事件循环卡住其他 run。
    await asyncio.to_thread(_publish, r, run_id, event)


async def process_run(run_id: str) -> None:
    """执行单个 run：跑 agent 的 astream → 逐事件埋点 + 推进度流 → 结果落 Redis → finish + 用量回调。
    事件契约 {type,data,node?}：node.start/node.end/step.done/error 落 event_log；
    结果取自 node.end.data.result（单循环）或 step.done.data.result（工作流每步）。
    同一路径上所有同步 Redis/PG 调用都经 asyncio.to_thread 卸载——worker 支持多 run 并发后，
    直接跑在事件循环上的同步调用会独占循环，卡住其它并发中的 run。"""
    r = get_redis()
    rec = _rec()
    raw_meta = await asyncio.to_thread(r.get, runmeta_key(run_id))
    meta = json.loads(raw_meta or "{}")
    agent_type, thread_id, input = meta.get("agent_type"), meta.get("thread_id", run_id), meta.get("input", {})

    if not agent_type:
        # runmeta 丢失/过期（>24h 积压等）：直接标失败，别让 NOT NULL agent_type 崩在 start_run 而留孤儿。
        await asyncio.to_thread(rec.finish_run, run_id, status="failed",
                                 error="runmeta missing or expired", error_type="MetaMissing")
        await _apublish(r, run_id, {"type": "run.end", "data": {"status": "failed", "error": "runmeta missing or expired"}})
        return

    await asyncio.to_thread(rec.start_run, run_id, agent_type, thread_id)
    await asyncio.to_thread(rec.log_event, run_id, agent_type, "run.start", thread_id=thread_id)
    await _apublish(r, run_id, {"type": "run.start"})

    model = meta.get("model")
    override = model_override_to_settings(model)
    # 有 per-run override 才新建 gateway；否则复用模块级单例 _gateway（零额外开销）
    gateway = ModelGateway(settings.model_copy(update=override)) if override else _gateway
    ctx = RunContext(run_id=run_id, agent_type=agent_type, thread_id=thread_id,
                     recorder=rec, gateway=gateway, redis=r)
    result = None
    nodes = set()
    try:
        agent = get_agent(agent_type)
        async for ev in agent.astream(input, ctx):
            if ev.get("node"):
                nodes.add(ev["node"])
            if ev["type"] in ("node.start", "node.end", "step.done", "error"):
                await asyncio.to_thread(rec.log_event, run_id, agent_type, ev["type"], node=ev.get("node"),
                                         data=ev.get("data"), thread_id=thread_id)
            # 单循环 agent 结果在 node.end.data.result；工作流每步结果在 step.done.data.result。
            if ev["type"] in ("node.end", "step.done") and isinstance(ev.get("data"), dict) and "result" in ev["data"]:
                result = ev["data"]["result"]
            await _apublish(r, run_id, ev)  # 全部事件推 SSE

        # finish 先行：finish_run 成功后再落 result，避免 finish 抛错时留下"结果在、状态却不是 succeeded"。
        await asyncio.to_thread(rec.finish_run, run_id, status="succeeded", node_count=len(nodes))
        await asyncio.to_thread(r.set, result_key(run_id), json.dumps(result), ex=86400)
        await _apublish(r, run_id, {"type": "run.end", "data": {"status": "succeeded"}})
        await _callback(run_id, agent_type, "succeeded")
    except Exception as e:  # noqa: BLE001
        await asyncio.to_thread(rec.log_event, run_id, agent_type, "error", level="error",
                                 data={"error": str(e)}, thread_id=thread_id)
        await asyncio.to_thread(rec.finish_run, run_id, status="failed",
                                 error=str(e), error_type=type(e).__name__)
        await _apublish(r, run_id, {"type": "run.end", "data": {"status": "failed", "error": str(e)}})
        await _callback(run_id, agent_type, "failed")


async def _callback(run_id: str, agent_type: str, status: str) -> None:
    if not settings.app_callback_url:
        return
    usage = await asyncio.to_thread(_rec().usage_summary, run_id)
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(settings.app_callback_url, json={"run_id": run_id, "agent_type": agent_type,
                                                          "status": status, "usage": usage})
    except Exception:  # noqa: BLE001
        pass  # 回调失败不阻断；App 侧另有对账
