from __future__ import annotations

import time
from typing import Any

from langchain_openai import ChatOpenAI

from agent.config import Settings
from agent.models.providers import PROVIDERS, KEY_FIELD
from agent.models.usage import extract_usage


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
                latency = int((time.monotonic() - t0) * 1000)
                if recorder is not None and run_id:
                    u = extract_usage(resp)
                    recorder.record_usage(
                        run_id, agent_type, provider=prov, model=getattr(chat, "model_name", mdl) or mdl,
                        input_tokens=u["input"], output_tokens=u["output"], cached_tokens=u["cached"],
                        reasoning_tokens=u["reasoning"], total_tokens=u["total"], node=node,
                        latency_ms=latency, finish_reason=u["finish_reason"], thread_id=thread_id,
                    )
                return resp
            except Exception as e:  # noqa: BLE001 故障转移：记录并降级
                last_err = e
                if recorder is not None and run_id:
                    recorder.log_event(
                        run_id, agent_type, "model.error", node=node, level="warn",
                        data={"provider": prov, "model": mdl, "error": str(e)}, thread_id=thread_id,
                    )
                continue
        assert last_err is not None
        raise last_err
