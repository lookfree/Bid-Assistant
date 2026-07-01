from __future__ import annotations

import json

import httpx

from agent.config import settings
from agent.db import get_pool
from agent.redis_client import get_redis
from agent.telemetry.recorder import Recorder
from agent.models.gateway import ModelGateway
from agent.runtime.channels import run_channel, runmeta_key, result_key
from agent.runtime.registry import get_agent, RunContext
import agent.runtime.dummy_agent  # noqa: F401 确保 dummy 注册

_gateway = ModelGateway(settings)          # 无副作用
_recorder: Recorder | None = None           # 惰性：import 期不连库


def _rec() -> Recorder:
    global _recorder
    if _recorder is None:
        _recorder = Recorder(get_pool())
    return _recorder


def _publish(r, run_id: str, event: dict) -> None:
    r.publish(run_channel(run_id), json.dumps(event))


async def process_run(run_id: str) -> None:
    r = get_redis()
    rec = _rec()
    meta = json.loads(r.get(runmeta_key(run_id)) or "{}")
    agent_type, thread_id, input = meta.get("agent_type"), meta.get("thread_id", run_id), meta.get("input", {})

    rec.start_run(run_id, agent_type, thread_id)
    rec.log_event(run_id, agent_type, "run.start", thread_id=thread_id)
    _publish(r, run_id, {"type": "run.start"})

    ctx = RunContext(run_id=run_id, agent_type=agent_type, thread_id=thread_id,
                     recorder=rec, gateway=_gateway, redis=r)
    result = None
    nodes = set()
    try:
        agent = get_agent(agent_type)
        async for ev in agent.astream(input, ctx):
            if ev.get("node"):
                nodes.add(ev["node"])
            if ev["type"] in ("node.start", "node.end", "error"):
                rec.log_event(run_id, agent_type, ev["type"], node=ev.get("node"),
                              data=ev.get("data"), thread_id=thread_id)
            if ev["type"] == "node.end" and isinstance(ev.get("data"), dict) and "result" in ev["data"]:
                result = ev["data"]["result"]
            _publish(r, run_id, ev)  # 全部事件推 SSE

        r.set(result_key(run_id), json.dumps(result), ex=86400)
        rec.finish_run(run_id, status="succeeded", node_count=len(nodes))
        _publish(r, run_id, {"type": "run.end", "data": {"status": "succeeded"}})
        await _callback(run_id, agent_type, "succeeded")
    except Exception as e:  # noqa: BLE001
        rec.log_event(run_id, agent_type, "error", level="error", data={"error": str(e)}, thread_id=thread_id)
        rec.finish_run(run_id, status="failed", error=str(e), error_type=type(e).__name__)
        _publish(r, run_id, {"type": "run.end", "data": {"status": "failed", "error": str(e)}})
        await _callback(run_id, agent_type, "failed")


async def _callback(run_id: str, agent_type: str, status: str) -> None:
    if not settings.app_callback_url:
        return
    usage = _rec().usage_summary(run_id)
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(settings.app_callback_url, json={"run_id": run_id, "agent_type": agent_type,
                                                          "status": status, "usage": usage})
    except Exception:  # noqa: BLE001
        pass  # 回调失败不阻断；App 侧另有对账
