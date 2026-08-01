"""ToolCallRecorder：agent_tool_call 表自建成起全库 0 行——recorder.record_tool 写好了但没有任何
调用点，deepagent 正文步跑 60 分钟事后连"调过哪些工具"都查不到（2026-08-01 空转事故的排查盲区）。
该回调挂到 config.callbacks 后逐次落行；埋点 best-effort，绝不影响工具执行。"""
import asyncio
from types import SimpleNamespace

from agent.telemetry.tool_recorder import ToolCallRecorder


class _CapRecorder:
    def __init__(self):
        self.rows: list[dict] = []

    def record_tool(self, run_id, agent_type, tool, **kw):
        self.rows.append({"run_id": run_id, "agent_type": agent_type, "tool": tool, **kw})


def _ctx(rec):
    return SimpleNamespace(run_id="r1", agent_type="bidding_agent", thread_id="t1",
                           recorder=rec, redis=None)


def test_tool_start_end_records_one_row_with_duration():
    rec = _CapRecorder()
    cb = ToolCallRecorder(_ctx(rec), "content")
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", run_id="lc1",
                                 inputs={"file_path": "chapters/t1.html", "content": "x" * 9000}))
    asyncio.run(cb.on_tool_end("ok", run_id="lc1"))
    assert len(rec.rows) == 1
    row = rec.rows[0]
    assert row["tool"] == "write_file" and row["ok"] is True and row["node"] == "content"
    assert row["duration_s"] is not None and row["duration_s"] >= 0
    # 参数摘要必须体量可控：write_file 的 content 是整章 HTML，只记长度、绝不整个进库
    summary = row["args_summary"]
    assert summary["file_path"] == "chapters/t1.html"
    assert "9000" in summary["content"] and len(summary["content"]) < 100


def test_tool_error_records_failed_row():
    rec = _CapRecorder()
    cb = ToolCallRecorder(_ctx(rec), "content")
    asyncio.run(cb.on_tool_start({"name": "task"}, "", run_id="lc2", inputs={"desc": "写第三章"}))
    asyncio.run(cb.on_tool_error(RuntimeError("boom"), run_id="lc2"))
    assert len(rec.rows) == 1
    assert rec.rows[0]["ok"] is False and "boom" in rec.rows[0]["error"]


def test_recorder_failure_never_breaks_the_tool():
    class _Boom:
        def record_tool(self, *a, **k):
            raise RuntimeError("pg down")

    cb = ToolCallRecorder(_ctx(_Boom()), "content")
    asyncio.run(cb.on_tool_start({"name": "ls"}, "", run_id="lc3", inputs={}))
    asyncio.run(cb.on_tool_end("ok", run_id="lc3"))   # 不抛 = 通过


def test_end_without_start_is_ignored():
    rec = _CapRecorder()
    cb = ToolCallRecorder(_ctx(rec), "content")
    asyncio.run(cb.on_tool_end("ok", run_id="never-started"))
    assert rec.rows == []
