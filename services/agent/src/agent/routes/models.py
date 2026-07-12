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
from agent.models.providers import PROVIDERS, KEY_FIELD

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
    base_url: str | None = None   # 自建端点直连
    api_key: str | None = None
    provider: str | None = None   # 内置服务商（deepseek/qwen/glm）：base_url + key 由服务端注册表/env 解析


def _resolve_provider_endpoint(provider: str) -> tuple[str | None, str | None]:
    """内置服务商 → (base_url, api_key)：base_url 取注册表，key 取 env（KEY_FIELD 映射的 Settings 字段）。
    未知 provider 或 env 缺 key → (None, None)，调用方按「拉取失败」处理，用户仍可手填模型名。"""
    if provider not in PROVIDERS:
        return None, None
    base_url = PROVIDERS[provider]["base_url"]
    api_key = getattr(settings, KEY_FIELD.get(provider, ""), None)
    return base_url, api_key


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
    """探 provider 的 GET /models，取可用模型 id 列表。自建端点用传入 base_url/api_key；
    内置服务商(provider)则由服务端从注册表/env 解析 base_url+key(前端不接触 env 密钥)。
    任何失败都不 500——超时/网络/非 2xx/解析错统一收敛成 {ok: false, error}，供 admin 拉取下拉候选。"""
    base_url, api_key = body.base_url, body.api_key
    if body.provider:   # 内置服务商:注册表默认链接 + env key 作回退;传入的 base_url/api_key 优先
        reg_url, env_key = _resolve_provider_endpoint(body.provider)
        base_url = base_url or reg_url
        api_key = api_key or env_key
    if not base_url:
        return JSONResponse({"ok": False, "error": "缺少 base_url 或未知服务商"})
    if not api_key:
        return JSONResponse({"ok": False, "error": "服务端未配置该服务商的 API Key"})
    url = f"{base_url.rstrip('/')}/models"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        ids = [item["id"] for item in data.get("data", []) if isinstance(item, dict) and item.get("id")]
        return JSONResponse({"ok": True, "models": ids[:100]})
    except Exception as e:  # noqa: BLE001 永不 500
        return JSONResponse({"ok": False, "error": str(e)[:200]})
