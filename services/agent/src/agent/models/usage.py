from typing import Any


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
