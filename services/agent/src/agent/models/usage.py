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
