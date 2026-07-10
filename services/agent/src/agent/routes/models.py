from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel

from agent.config import settings
from agent.models.gateway import ModelGateway, model_override_to_settings
from agent.models.providers import PROVIDERS

# spec319：模型连通性测试探针——App/admin relay 过来的一次性调用，不落库不计费。

router = APIRouter()


class TestBody(BaseModel):
    provider: str
    model: str | None = None
    params: dict | None = None


@router.post("/models/test")
async def test_model(body: TestBody):
    if body.provider not in PROVIDERS:
        return JSONResponse({"ok": False, "error": f"未知服务商 {body.provider}"}, status_code=400)
    override = model_override_to_settings({"params": body.params} if body.params else None)
    gw = ModelGateway(settings.model_copy(update=override))
    try:
        chat = gw.get_chat(body.provider, body.model)   # provider 无 key 会 RuntimeError
    except RuntimeError as e:
        return JSONResponse({"ok": False, "error": str(e)})
    try:
        t0 = time.monotonic()
        resp = await asyncio.wait_for(chat.ainvoke([HumanMessage(content="请回复：OK")]), timeout=15)
        latency = int((time.monotonic() - t0) * 1000)
        tokens = (getattr(resp, "usage_metadata", None) or {}).get("total_tokens", 0)
        return JSONResponse({"ok": True, "latency_ms": latency, "tokens": tokens})
    except asyncio.TimeoutError:
        return JSONResponse({"ok": False, "error": "调用超时（15s）"})
    except Exception as e:  # noqa: BLE001 回可读错误，不 500
        return JSONResponse({"ok": False, "error": str(e)[:200]})
