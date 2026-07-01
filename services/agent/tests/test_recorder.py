import uuid

import pytest

from agent.db import get_pool
from agent.telemetry.schema import setup_telemetry
from agent.telemetry.recorder import Recorder


@pytest.fixture(scope="module", autouse=True)
def _schema():
    setup_telemetry(get_pool())


def _cleanup(run_id: str):
    pool = get_pool()
    with pool.connection() as conn:
        for t in ("agent_event_log", "agent_token_usage", "agent_tool_call", "agent_request"):
            conn.execute(f"delete from agent.{t} where run_id=%s", (run_id,))
        conn.commit()


def test_full_run_records_and_usage_summary():
    rec = Recorder(get_pool())
    run_id = str(uuid.uuid4())
    thread_id = str(uuid.uuid4())  # 会话键（与 run_id 不同，体现"会话含多 run"）
    agent_type = "bidding_agent"
    try:
        rec.start_run(run_id, agent_type, thread_id=thread_id, file_refs=["uploads/x/y.pdf"])
        rec.log_event(run_id, agent_type, "node.start", node="read", thread_id=thread_id,
                      event_meta={"trace": "t1"})
        rec.record_usage(run_id, agent_type, provider="deepseek", model="deepseek-chat",
                         input_tokens=1200, output_tokens=300, cached_tokens=800, reasoning_tokens=150,
                         node="read", ttft_ms=120, latency_ms=900, thread_id=thread_id)
        rec.record_tool(run_id, agent_type, tool="parse_docx", ok=True, duration_ms=42, node="read", thread_id=thread_id)
        rec.log_event(run_id, agent_type, "node.end", node="read", thread_id=thread_id)
        rec.finish_run(run_id, status="succeeded", node_count=1)

        # 校验 agent_request（thread_id 会话键 + 完成时回填的用量汇总）
        with get_pool().connection() as conn:
            row = conn.execute(
                """select status, node_count, agent_type, finished_at, thread_id,
                          input_tokens, output_tokens, cached_tokens, total_tokens
                   from agent.agent_request where run_id=%s""",
                (run_id,),
            ).fetchone()
        assert row[0] == "succeeded" and row[1] == 1 and row[2] == agent_type and row[3] is not None
        assert row[4] == thread_id
        assert (row[5], row[6], row[7], row[8]) == (1200, 300, 800, 1500)  # 回填正确

        # 校验 token_usage 的 LLM 耗时字段
        with get_pool().connection() as conn:
            u = conn.execute(
                "select ttft_ms, latency_ms, reasoning_tokens from agent.agent_token_usage where run_id=%s", (run_id,)
            ).fetchone()
        assert u == (120, 900, 150)

        # 校验事件：数量 + seq 单调 + event_type + thread_id
        with get_pool().connection() as conn:
            evs = conn.execute(
                "select seq, event_type, thread_id from agent.agent_event_log where run_id=%s order by seq",
                (run_id,),
            ).fetchall()
        assert [e[0] for e in evs] == [1, 2]
        assert [e[1] for e in evs] == ["node.start", "node.end"]
        assert evs[0][2] == thread_id

        # 校验用量汇总（input/output/cached/total）
        s = rec.usage_summary(run_id)
        assert s["input"] == 1200 and s["output"] == 300 and s["cached"] == 800
        assert s["total"] == 1500 and s["calls"] == 1  # total 缺省 = input+output
    finally:
        _cleanup(run_id)


def test_edge_cases_empty_payload_resume_and_none_provider():
    rec = Recorder(get_pool())
    run_id = str(uuid.uuid4())
    thread_id = str(uuid.uuid4())
    at = "bidding_agent"
    try:
        # 空 file_refs=[] 应落成 []（非 NULL）——"空"与"缺失"要可区分
        rec.start_run(run_id, at, thread_id=thread_id, file_refs=[])
        with get_pool().connection() as conn:
            first = conn.execute(
                "select started_at, file_refs from agent.agent_request where run_id=%s", (run_id,)
            ).fetchone()
        assert first[1] == []

        # resume：再次 start_run 保留首次 started_at（不被冲掉）
        rec.start_run(run_id, at, thread_id=thread_id)
        with get_pool().connection() as conn:
            second_started = conn.execute(
                "select started_at from agent.agent_request where run_id=%s", (run_id,)
            ).fetchone()[0]
        assert second_started == first[0]

        # provider/model=None 不丢用量，兜底 'unknown'
        rec.record_usage(run_id, at, provider=None, model=None, input_tokens=10, output_tokens=5)
        with get_pool().connection() as conn:
            u = conn.execute(
                "select provider, model, total_tokens from agent.agent_token_usage where run_id=%s", (run_id,)
            ).fetchone()
        assert u == ("unknown", "unknown", 15)
    finally:
        _cleanup(run_id)
