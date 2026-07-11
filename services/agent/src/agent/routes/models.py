from __future__ import annotations

import asyncio
import time

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from langchain_core.messages import HumanMessage
from pydantic import BaseModel

from agent.config import settings
from agent.models.gateway import ModelGateway, model_override_to_settings
from agent.models.providers import PROVIDERS

# spec319/spec319.1：模型连通性测试探针 + 自建端点可用模型列举——
# App/admin relay 过来的一次性调用，不落库不计费。

router = APIRouter()


class TestBody(BaseModel):
    provider: str
    model: str | None = None
    params: dict | None = None
    base_url: str | None = None   # 非空 ⇒ 自建/任意 OpenAI 兼容端点，跳过 PROVIDERS 白名单
    api_key: str | None = None


class ListModelsBody(BaseModel):
    base_url: str
    api_key: str


@router.post("/models/test")
async def test_model(body: TestBody):
    if not body.base_url and body.provider not in PROVIDERS:
        return JSONResponse({"ok": False, "error": f"未知服务商 {body.provider}"}, status_code=400)
    override = model_override_to_settings({"params": body.params} if body.params else None)
    gw = ModelGateway(settings.model_copy(update=override))
    try:
        # base_url 透传：自建端点直连；registry 路径（base_url=None）行为不变
        chat = gw.get_chat(body.provider, body.model, base_url=body.base_url, api_key=body.api_key)
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


@router.post("/models/list-models")
async def list_models(body: ListModelsBody):
    """探自建端点的 GET /models，取可用模型 id 列表。任何失败都不 500——超时/网络/非 2xx/解析错
    统一收敛成 {ok: false, error}，供 admin 在填 base_url/api_key 后拉取下拉候选。"""
    url = f"{body.base_url.rstrip('/')}/models"
    headers = {"Authorization": f"Bearer {body.api_key}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        ids = [item["id"] for item in data.get("data", []) if isinstance(item, dict) and item.get("id")]
        return JSONResponse({"ok": True, "models": ids[:100]})
    except Exception as e:  # noqa: BLE001 永不 500
        return JSONResponse({"ok": False, "error": str(e)[:200]})
