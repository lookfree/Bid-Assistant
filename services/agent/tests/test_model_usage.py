from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from agent.models.usage import UsageCallback, extract_usage, record_ctx_usage


class _CapRecorder:
    """记下最后一次 record_usage 的 kwargs，供断言 latency_ms 是否落库。"""

    def __init__(self):
        self.calls: list[dict] = []

    def record_usage(self, run_id, agent_type, **kw):
        self.calls.append(kw)


def _ctx(recorder):
    return SimpleNamespace(run_id="r1", agent_type="bidding_agent", thread_id="t1",
                           recorder=recorder, gateway=None)


def _usage_msg():
    return AIMessage(content="hi", usage_metadata={"input_tokens": 10, "output_tokens": 2,
                                                   "total_tokens": 12}, response_metadata={})


def test_record_ctx_usage_passes_latency():
    """record_ctx_usage 把调用方计时的 latency_ms 透传到 recorder.record_usage。"""
    rec = _CapRecorder()
    record_ctx_usage(_ctx(rec), _usage_msg(), node="content", model="m", latency_ms=850)
    assert rec.calls and rec.calls[-1]["latency_ms"] == 850


async def test_usage_callback_records_latency():
    """UsageCallback：on_chat_model_start 打点 → on_llm_end 记账，latency_ms 有值且 node 正确。"""
    rec = _CapRecorder()
    cb = UsageCallback(_ctx(rec), "content")
    await cb.on_chat_model_start({}, [], run_id="lc1")
    result = LLMResult(generations=[[ChatGeneration(message=_usage_msg())]])
    await cb.on_llm_end(result, run_id="lc1")
    assert rec.calls and rec.calls[-1]["node"] == "content"
    assert rec.calls[-1]["latency_ms"] is not None and rec.calls[-1]["latency_ms"] >= 0


async def test_usage_callback_latency_none_without_start():
    """缺 start 打点（如回调乱序）时 latency_ms 落 None，仍照常记 token（best-effort 不丢用量）。"""
    rec = _CapRecorder()
    cb = UsageCallback(_ctx(rec), "content")
    result = LLMResult(generations=[[ChatGeneration(message=_usage_msg())]])
    await cb.on_llm_end(result, run_id="orphan")
    assert rec.calls and rec.calls[-1]["latency_ms"] is None


def test_extract_usage_from_usage_metadata():
    msg = SimpleNamespace(
        usage_metadata={
            "input_tokens": 1200,
            "output_tokens": 300,
            "total_tokens": 1500,
            "input_token_details": {"cache_read": 800},
            "output_token_details": {"reasoning": 150},
        },
        response_metadata={"finish_reason": "stop"},
    )
    u = extract_usage(msg)
    assert u == {"input": 1200, "output": 300, "cached": 800, "reasoning": 150, "total": 1500, "finish_reason": "stop"}


def test_extract_usage_defaults_when_missing():
    msg = SimpleNamespace(usage_metadata=None, response_metadata={})
    u = extract_usage(msg)
    assert u["input"] == 0 and u["output"] == 0 and u["cached"] == 0 and u["reasoning"] == 0 and u["total"] == 0
