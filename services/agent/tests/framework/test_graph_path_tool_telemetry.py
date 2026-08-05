"""带工具的兜底路径（run_submit_agent + extra_tools → build_create_agent 图）必须落工具调用埋点。

2026-08-05 排查实录：读标因文件无法解析走了这条兜底路径，模型连调三次工具全失败、第四轮改回
纯文本收尾。agent_tool_call 表当天一行没有——ToolCallRecorder 只挂在 content 的 deepagent 上，
这条图路径漏了。「调了哪个工具、参数是什么、报了什么错」全查不到，只能靠 token 表的
finish_reason 序列反推。恰恰是最需要它的路径没有埋点。
"""
import uuid

from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from pydantic import BaseModel

from agent.framework.create_agent import run_submit_agent
from agent.runtime.registry import RunContext


class Toy(BaseModel):
    x: int


@tool
def probe_document(key: str) -> str:
    """兜底解析工具的替身（对应真实的 parse_document）。"""
    raise RuntimeError("解析失败：文件已被加密软件封装")


class _ToolThenSubmit:
    """先调一次工具（会失败），拿到 ToolMessage 后再提交——复现兜底路径的真实形状。"""

    def __init__(self):
        self.n = 0

    def bind_tools(self, tools, **kw):
        return self

    async def ainvoke(self, messages, **kw):
        self.n += 1
        if self.n == 1:
            return AIMessage(content="", tool_calls=[
                {"name": "probe_document", "args": {"key": "uploads/a.pdf"}, "id": "c1"}])
        if self.n == 2:
            return AIMessage(content="", tool_calls=[
                {"name": "submit_x", "args": {"x": 1}, "id": "c2"}])
        return AIMessage(content="已提交")   # 无工具调用 → 图收尾（否则子图无限循环）


class _Gateway:
    def __init__(self, chat):
        self.chat = chat

    def get_chat(self, *a, **kw):
        return self.chat


class _CapRecorder:
    def __init__(self):
        self.rows: list[dict] = []

    def record_tool(self, run_id, agent_type, tool, **kw):
        self.rows.append({"tool": tool, **kw})

    def log_event(self, *a, **kw):
        pass

    def record_usage(self, *a, **kw):
        pass


async def test_graph_path_records_tool_calls():
    """兜底路径每次工具调用都要落 agent_tool_call：工具名、成败、报错、参数摘要一个不少。"""
    rec = _CapRecorder()
    ctx = RunContext(run_id=str(uuid.uuid4()), agent_type="bidding_agent",
                     thread_id=str(uuid.uuid4()), gateway=_Gateway(_ToolThenSubmit()), recorder=rec)

    await run_submit_agent(ctx, "SYS", "USER", "submit_x", Toy, "提交读标结构化结果",
                           extra_tools=[probe_document])

    probe = [r for r in rec.rows if r["tool"] == "probe_document"]
    assert probe, "兜底路径的工具调用没有落 agent_tool_call —— 这正是排查时最需要的那一行"
    assert probe[0]["ok"] is False
    assert "加密" in (probe[0]["error"] or "")
    assert probe[0]["args_summary"]["key"] == "uploads/a.pdf"
    assert probe[0]["node"] == "提交读标结构化结果"
