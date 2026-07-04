from __future__ import annotations

import time
from typing import Any

from langchain_openai import ChatOpenAI

from agent.config import Settings
from agent.models.providers import PROVIDERS, KEY_FIELD
from agent.models.usage import record_llm_usage


class ModelGateway:
    def __init__(self, settings: Settings) -> None:
        self.s = settings

    def _api_key(self, provider: str) -> str:
        key = getattr(self.s, KEY_FIELD[provider], None)
        if not key:
            raise RuntimeError(f"模型 provider '{provider}' 缺少 API Key（{KEY_FIELD[provider].upper()}）")
        return key

    def get_chat(self, provider: str | None = None, model: str | None = None, **kw: Any) -> ChatOpenAI:
        provider = provider or self.s.model_default_provider   # 容忍 provider=None，回退默认家
        p = PROVIDERS[provider]
        return ChatOpenAI(
            model=model or p["default_model"],
            base_url=p["base_url"],
            api_key=self._api_key(provider),
            **kw,
        )

    def _chain(self, provider: str | None, model: str | None) -> list[tuple[str, str | None]]:
        first = (provider or self.s.model_default_provider, model or self.s.model_default_model)
        fb: list[tuple[str, str | None]] = []
        for item in (self.s.model_fallbacks or "").split(","):
            item = item.strip()
            if ":" in item:
                prov, mdl = item.split(":", 1)
                fb.append((prov.strip(), mdl.strip()))
        return [first, *fb]

    def _log_model_error(
        self, recorder: Any, run_id: str | None, agent_type: str | None,
        provider: str, model: str | None, node: str | None, thread_id: str | None, err: Exception,
    ) -> None:
        """故障转移时记 model.error（best-effort，埋点失败不能拖垮转移）。"""
        if recorder is None or not run_id:
            return
        try:
            recorder.log_event(
                run_id, agent_type, "model.error", node=node, level="warn",
                data={"provider": provider, "model": model, "error": str(err)}, thread_id=thread_id,
            )
        except Exception:  # noqa: BLE001 埋点 best-effort
            pass

    def invoke(
        self, messages: Any, provider: str | None = None, model: str | None = None, *,
        recorder: Any = None, run_id: str | None = None, agent_type: str | None = None,
        node: str | None = None, thread_id: str | None = None,
    ) -> Any:
        last_err: Exception | None = None
        for prov, mdl in self._chain(provider, model):
            try:
                t0 = time.monotonic()
                chat = self.get_chat(prov, mdl)
                resp = chat.invoke(messages)
            except Exception as e:  # noqa: BLE001 provider/调用失败 → 故障转移到下一家
                last_err = e
                self._log_model_error(recorder, run_id, agent_type, prov, mdl, node, thread_id, e)
                continue
            # LLM 已成功：埋点必须 best-effort——记录失败绝不能丢这次响应或触发（重复计费的）转移。
            latency = int((time.monotonic() - t0) * 1000)
            record_llm_usage(recorder, run_id=run_id, agent_type=agent_type, provider=prov,
                             model=getattr(chat, "model_name", mdl) or mdl, msg=resp,
                             node=node, thread_id=thread_id, latency_ms=latency)
            return resp
        assert last_err is not None
        raise last_err


_OVERRIDE_MAP = {
    "provider": "model_default_provider",
    "model": "model_default_model",
    "fallbacks": "model_fallbacks",
}


def model_override_to_settings(sel: dict | None) -> dict:
    """把 run 携带的 {provider,model,fallbacks} 映射为 Settings 字段；丢弃 None/缺失（spec311）。
    结果可直接喂 Settings.model_copy(update=...) 覆盖 env 默认。"""
    if not sel:
        return {}
    return {_OVERRIDE_MAP[k]: v for k, v in sel.items() if k in _OVERRIDE_MAP and v is not None}
