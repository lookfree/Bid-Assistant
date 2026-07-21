from __future__ import annotations

import time
from typing import Any

from langchain_openai import ChatOpenAI

from agent.config import Settings
from agent.models.providers import PROVIDERS, KEY_FIELD, THINKING_DISABLE
from agent.models.usage import record_llm_usage


class ModelGateway:
    def __init__(self, settings: Settings) -> None:
        self.s = settings

    def _model_params(self) -> dict:
        """把 Settings 里的采样参数组装成 ChatOpenAI 构造 kwargs（None 的不传，用 provider 默认）。
        注意：max_tokens 不在此——它必须走 extra_body（见 _extra_body），否则被 langchain 改名后失效。"""
        out: dict = {}
        if self.s.model_temperature is not None:
            out["temperature"] = self.s.model_temperature
        if self.s.model_top_p is not None:
            out["top_p"] = self.s.model_top_p
        return out

    def _extra_body(self, provider: str | None, thinking: bool | None, max_tokens: int | None) -> dict:
        """组 extra_body（原样透传给端点）：关闭思考参 + max_tokens。
        - 思考默认关（thinking 缺省取全局 settings.model_thinking）：让混合思考模型可流式强制提交、更快更省；
          provider 不在 THINKING_DISABLE 表内（自建/未知）不注入（不知其关闭参格式）。
        - max_tokens 走 extra_body 而非构造参：langchain-openai(1.x) 会把构造参 max_tokens 改名成
          max_completion_tokens，而 deepseek/qwen/glm 的 OpenAI 兼容端点只认 max_tokens（实测 2026-07-20：
          max_completion_tokens 被忽略 → 回退默认 8192 输出，配多大都不生效）。extra_body 原样进请求体。"""
        if thinking is None:
            thinking = self.s.model_thinking
        body: dict = {}
        if not thinking:
            body.update(THINKING_DISABLE.get(provider or "", {}))
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        return body

    def get_chat(
        self, provider: str | None = None, model: str | None = None, *,
        base_url: str | None = None, api_key: str | None = None,
        thinking: bool | None = None, **kw: Any,
    ) -> ChatOpenAI:
        """统一端点解析（内置与自建同一套）：base_url 显式给了用它，否则取内置服务商注册表默认。
        api_key **只认显式传入**（运营后台配置，经模型链/调用方下发）——绝不回退环境变量：
        env key 会静默掩盖「后台未配置」，违反铁律「模型唯一来自运营后台配置，未配置就报错」。
        thinking：每模型思考开关；None=取全局默认（settings.model_thinking，缺省关），True 显式开启。"""
        # 完全未指定模型（provider/base_url/api_key 全空）且有后台模型链 → 采用链首（主模型）完整配置。
        # content(deepagent)/make_agent_node 只调 get_chat(provider=None)：此前该路径回退
        # default_provider + env key，后台配置的 api_key 传不进来——key 只在后台配置（铁律）、env 无 key
        # 的部署下直接抛「缺少 API Key」，而走链条的读标/提纲等步骤全部正常（生产实测 content 步复现）。
        if provider is None and base_url is None and api_key is None and self.s.model_chain:
            head = self.s.model_chain[0]
            provider = head.get("provider")
            model = model or head.get("model")
            base_url = head.get("base_url")
            api_key = head.get("api_key")
        p = PROVIDERS.get(provider) if provider else None
        if not base_url:
            if p:
                base_url = p["base_url"]
            else:   # 未知 provider 且无 base_url：回退默认家（容忍 provider=None/异常装配）
                provider = self.s.model_default_provider
                base_url = PROVIDERS[provider]["base_url"]
                p = PROVIDERS[provider]
        # 内置服务商（KEY_FIELD 名单）必须有显式 key；自建/未知 provider 用占位（端点自己不鉴权）。
        key = api_key or ("sk-noauth" if provider not in KEY_FIELD else None)
        if not key:
            raise RuntimeError(f"模型 provider '{provider}' 未配置 API Key——请在运营后台「模型管理」为该模型配置密钥")
        # max_tokens 与思考关闭参统一走 extra_body（原样透传）。显式 kw > settings；
        # 调用方自带 extra_body 时整体让路（不注入思考/上限，避免覆盖其自定义字段）。
        max_tokens = kw.pop("max_tokens", None)
        if max_tokens is None:
            max_tokens = self.s.model_max_tokens
        # 注入(思考关闭参 + max_tokens)在前、调用方自带 extra_body 覆盖在后——二者合并而非二选一，
        # 否则调用方传了别的 extra_body 就会把 max_tokens 一起丢掉，回退 deepseek 默认 8192 输出、重现截断。
        extra = {**self._extra_body(provider, thinking, max_tokens), **(kw.pop("extra_body", None) or {})}
        return ChatOpenAI(
            model=model or (p["default_model"] if p else None),
            base_url=base_url,
            api_key=key,
            **{**self._model_params(), **({"extra_body": extra} if extra else {}), **kw},
        )

    def chain(self) -> list[dict]:
        """对外暴露解析后的模型链（首项=主模型，其后=降级模型），供流式调用做空闲超时后的降级重试。"""
        return self._chain(None, None)

    def _chain(self, provider: str | None, model: str | None) -> list[dict]:
        """结构化故障转移链：settings.model_chain 非空（run override 注入）⇒ 原样返回；
        否则由 provider/model/fallbacks 拼旧行为，每项补 base_url=None, api_key=None（向后兼容）。"""
        if self.s.model_chain:
            return self.s.model_chain
        first = {
            "provider": provider or self.s.model_default_provider,
            "model": model or self.s.model_default_model,
            "base_url": None, "api_key": None,
        }
        fb: list[dict] = []
        for item in (self.s.model_fallbacks or "").split(","):
            item = item.strip()
            if ":" in item:
                prov, mdl = item.split(":", 1)
                fb.append({"provider": prov.strip(), "model": mdl.strip(), "base_url": None, "api_key": None})
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
        for it in self._chain(provider, model):
            prov, mdl = it["provider"], it["model"]
            try:
                t0 = time.monotonic()
                chat = self.get_chat(prov, mdl, base_url=it["base_url"], api_key=it["api_key"],
                                     thinking=it.get("thinking"))   # 每模型思考开关随链条项生效
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


def _params_override(params: dict) -> dict:
    """把 run 携带的采样参数 {temperature,max_tokens,top_p} 映射为 Settings 字段；
    越界/非数值 → 丢弃该项（不抛，与 unknown-provider 一致的"安全回退默认"语义）。"""
    out: dict = {}
    temperature = params.get("temperature")
    if isinstance(temperature, (int, float)) and not isinstance(temperature, bool) and 0 <= temperature <= 2:
        out["model_temperature"] = temperature
    top_p = params.get("top_p")
    if isinstance(top_p, (int, float)) and not isinstance(top_p, bool) and 0 <= top_p <= 1:
        out["model_top_p"] = top_p
    max_tokens = params.get("max_tokens")
    if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
        out["model_max_tokens"] = max_tokens
    return out


def _clean_chain_item(item: Any) -> dict | None:
    """校验/清洗单个结构化链条目：model 非空；有 base_url 则须 http/https；否则丢弃整项。
    不校验 provider 白名单（自建端点 provider 是自由标签）。"""
    if not isinstance(item, dict):
        return None
    model = item.get("model")
    if not model:
        return None
    base_url = item.get("base_url")
    if base_url and not (isinstance(base_url, str) and base_url.startswith(("http://", "https://"))):
        return None
    return {
        "provider": item.get("provider"),
        "model": model,
        "base_url": base_url or None,
        "api_key": item.get("api_key") or None,
        "thinking": item.get("thinking") is True,   # 每模型思考开关（默认关）
    }


def _chain_override(chain: Any) -> list[dict]:
    if not isinstance(chain, list):
        return []
    cleaned = (_clean_chain_item(item) for item in chain)
    return [c for c in cleaned if c is not None]


def model_override_to_settings(sel: dict | None) -> dict:
    """把 run 携带的 {provider,model,fallbacks,params,chain} 映射为 Settings 字段；覆盖 env 默认（spec311）。
    空串/None/缺失 → 丢弃（继承 env，默认配置即 no-op）；未知 provider → 丢弃（避免 run 时 KeyError）；
    params/chain 不在 _OVERRIDE_MAP 里，单独校验后映射（spec319/spec319.1）。"""
    if not sel:
        return {}
    out: dict = {}
    for k, v in sel.items():
        if k == "params":
            if isinstance(v, dict):
                out.update(_params_override(v))
            continue
        if k == "chain":
            cleaned = _chain_override(v)
            if cleaned:
                out["model_chain"] = cleaned
                # 全局思考默认取主模型（链首）开关：覆盖 content(deepagent)/make_agent_node 等
                # 不走链条项、只调 get_chat(provider=None) 的路径。
                out["model_thinking"] = bool(cleaned[0].get("thinking"))
            continue
        if k not in _OVERRIDE_MAP or not v:
            continue
        if k == "provider" and v not in PROVIDERS:
            continue
        out[_OVERRIDE_MAP[k]] = v
    return out
