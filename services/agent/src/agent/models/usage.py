from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult


def extract_usage(msg: Any) -> dict[str, Any]:
    """从 langchain AIMessage 抽取统一用量。
    usage_metadata: {input_tokens, output_tokens, total_tokens,
                     input_token_details:{cache_read}, output_token_details:{reasoning}}"""
    um = getattr(msg, "usage_metadata", None) or {}
    input_ = int(um.get("input_tokens", 0) or 0)
    output = int(um.get("output_tokens", 0) or 0)
    total = int(um.get("total_tokens", input_ + output) or (input_ + output))
    cached = int((um.get("input_token_details") or {}).get("cache_read", 0) or 0)
    reasoning = int((um.get("output_token_details") or {}).get("reasoning", 0) or 0)
    finish_reason = (getattr(msg, "response_metadata", None) or {}).get("finish_reason")
    return {
        "input": input_, "output": output, "cached": cached,
        "reasoning": reasoning, "total": total, "finish_reason": finish_reason,
    }


def record_llm_usage(recorder: Any, *, run_id: str | None, agent_type: str | None,
                     provider: str | None, model: str | None, msg: Any,
                     node: str | None = None, thread_id: str | None = None,
                     latency_ms: int | None = None) -> None:
    """从 msg 抽用量并 best-effort 落库——埋点/DB 失败绝不拖垮已成功的 LLM 调用。
    gateway.invoke 与 framework agent_node 共用（两处都直连 LLM，用量得自己记）。"""
    if recorder is None or not run_id:
        return
    try:
        u = extract_usage(msg)
        recorder.record_usage(
            run_id, agent_type, provider=provider, model=model,
            input_tokens=u["input"], output_tokens=u["output"], cached_tokens=u["cached"],
            reasoning_tokens=u["reasoning"], total_tokens=u["total"], node=node,
            latency_ms=latency_ms, finish_reason=u["finish_reason"], thread_id=thread_id,
        )
    except Exception:  # noqa: BLE001 埋点 best-effort
        pass


def record_ctx_usage(ctx: Any, msg: Any, *, node: str | None, model: str | None = None) -> None:
    """按 RunContext 记一条 LLM 用量（best-effort）。make_agent_node 与 UsageCallback 共用，
    provider/run 维度参数只在这里拼一次，避免两条埋点路径漂移。"""
    _s = getattr(ctx.gateway, "s", None) if ctx.gateway else None
    record_llm_usage(ctx.recorder, run_id=ctx.run_id, agent_type=ctx.agent_type,
                     provider=getattr(_s, "model_default_provider", None),
                     model=model or (getattr(msg, "response_metadata", None) or {}).get("model_name"),
                     msg=msg, node=node, thread_id=ctx.thread_id)


class UsageCallback(AsyncCallbackHandler):
    """langchain 回调式埋点：deepagent 等「直驱模型、不经 make_agent_node」的路径
    挂到 config.callbacks 上记 token 用量（content 节点是最大消费者，绕过即漏计费）。"""

    def __init__(self, ctx: Any, node: str):
        self.ctx = ctx
        self.node = node

    async def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        """每次 LLM 调用结束触发：从 ChatGeneration.message 抽 usage_metadata 记账。"""
        try:
            msg = response.generations[0][0].message
        except (IndexError, AttributeError):
            return                       # 非 chat 型结果（无 .message）不记
        record_ctx_usage(self.ctx, msg, node=self.node)
