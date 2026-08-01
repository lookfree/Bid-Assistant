from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from agent.models.usage import UsageCallback, extract_usage, record_ctx_usage


class _CapRecorder:
    """记下最后一次 record_usage 的 kwargs，供断言 latency_s 是否落库。"""

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
    """record_ctx_usage 把调用方计时的 latency_s（秒）透传到 recorder.record_usage。"""
    rec = _CapRecorder()
    record_ctx_usage(_ctx(rec), _usage_msg(), node="content", model="m", latency_s=0.85)
    assert rec.calls and rec.calls[-1]["latency_s"] == 0.85


async def test_usage_callback_records_latency():
    """UsageCallback：on_chat_model_start 打点 → on_llm_end 记账，latency_s 有值且 node 正确。"""
    rec = _CapRecorder()
    cb = UsageCallback(_ctx(rec), "content")
    await cb.on_chat_model_start({}, [], run_id="lc1")
    result = LLMResult(generations=[[ChatGeneration(message=_usage_msg())]])
    await cb.on_llm_end(result, run_id="lc1")
    assert rec.calls and rec.calls[-1]["node"] == "content"
    assert rec.calls[-1]["latency_s"] is not None and rec.calls[-1]["latency_s"] >= 0


async def test_usage_callback_latency_none_without_start():
    """缺 start 打点（如回调乱序）时 latency_s 落 None，仍照常记 token（best-effort 不丢用量）。"""
    rec = _CapRecorder()
    cb = UsageCallback(_ctx(rec), "content")
    result = LLMResult(generations=[[ChatGeneration(message=_usage_msg())]])
    await cb.on_llm_end(result, run_id="orphan")
    assert rec.calls and rec.calls[-1]["latency_s"] is None


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


class _CapEventRecorder(_CapRecorder):
    """record_usage 照记，另捕获 log_event——校验截断异常事件。"""

    def __init__(self):
        super().__init__()
        self.events: list[dict] = []

    def log_event(self, run_id, agent_type, event_type, **kw):
        self.events.append({"event_type": event_type, **kw})


def _truncated_msg():
    return AIMessage(content="…", usage_metadata={"input_tokens": 90000, "output_tokens": 16384,
                                                  "total_tokens": 106384},
                     response_metadata={"finish_reason": "length"})


def test_truncated_call_logs_warn_event():
    """finish_reason=length 是异常事件：此前只落 token_usage 的指标列，没有任何日志/告警入口，
    2026-08-01 正文步 7 次截断引发整章重写循环，事后全靠手写 SQL 对时间线。
    现在每次截断落一条 model.truncated(level=warn) 进 agent_event_log。"""
    rec = _CapEventRecorder()
    record_ctx_usage(_ctx(rec), _truncated_msg(), node="content", model="qwen", latency_s=0.1)
    ev = [e for e in rec.events if e["event_type"] == "model.truncated"]
    assert len(ev) == 1 and ev[0]["level"] == "warn" and ev[0]["node"] == "content"
    assert ev[0]["data"]["output_tokens"] == 16384


def test_normal_finish_logs_no_truncation_event():
    rec = _CapEventRecorder()
    record_ctx_usage(_ctx(rec), _usage_msg(), node="content", model="qwen")
    assert [e for e in rec.events if e["event_type"] == "model.truncated"] == []


def test_recorder_without_log_event_still_records_usage():
    """旧 recorder（无 log_event 方法）兼容：用量照记，不因埋点缺方法抛错。"""
    rec = _CapRecorder()
    record_ctx_usage(_ctx(rec), _truncated_msg(), node="content", model="qwen")
    assert rec.calls   # record_usage 正常
