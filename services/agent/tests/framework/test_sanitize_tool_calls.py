"""坏工具参数的发送前无害化（2026-08-08 生产事故）。

流式某一轮把 write_todos 的参数 JSON 拼坏，坏消息被 checkpointer 存进历史；
之后每次调用都把历史原样发回端点，vLLM 渲染对话模板时 json.loads 那串坏参数，
在固定字符位炸出 400 "Expecting ',' delimiter"——流式非流式都一样，病根在库里。
create_agent 路线早有 DropMalformedToolCallsHook，deepagents 路线此前裸奔。
"""
import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from agent.framework.sanitize_tool_calls import SanitizeToolCallsMiddleware, sanitize_messages

# 复刻事故形态：arguments 在中途缺了分隔符，json.loads 必炸
_BAD_ARGS = '{"todos": [{"content": "写第一章" "status": "pending"}]}'
_BAD_MSG = AIMessage(
    content="",
    additional_kwargs={"tool_calls": [{
        "id": "call_x", "type": "function",
        "function": {"name": "write_todos", "arguments": _BAD_ARGS}}]})


def _all_args_parse(messages) -> bool:
    for m in messages:
        for tc in (getattr(m, "additional_kwargs", {}) or {}).get("tool_calls") or []:
            json.loads((tc.get("function") or {}).get("arguments") or "{}")
        for c in getattr(m, "invalid_tool_calls", None) or []:
            json.loads(c.get("args") or "{}")
    return True


class TestSanitize:
    def test_bad_arguments_become_sendable(self):
        """坏参数出网前必须变成合法 JSON——这正是端点 400 的那个位置。"""
        out = sanitize_messages([_BAD_MSG])
        assert _all_args_parse(out)
        args = out[0].additional_kwargs["tool_calls"][0]["function"]["arguments"]
        assert args == "{}"

    def test_pairing_with_the_tool_message_is_kept(self):
        """替换而不是删除：删了 AIMessage 会留下孤儿 ToolMessage，端点同样拒收。
        模型看到"我调了 write_todos、被拒了"，才会重发一次正确的调用。"""
        tm = ToolMessage(content="could not be executed - arguments were malformed", tool_call_id="call_x")
        out = sanitize_messages([_BAD_MSG, tm])
        assert len(out) == 2 and out[1] is tm
        assert out[0].additional_kwargs["tool_calls"][0]["id"] == "call_x"

    def test_invalid_tool_calls_never_leave_as_raw_strings(self):
        """langchain 把解析失败的调用放进 invalid_tool_calls，序列化时**原串照发**——同样要拦。"""
        m = AIMessage(content="", invalid_tool_calls=[
            {"name": "write_todos", "args": _BAD_ARGS, "id": "call_y", "error": "boom", "type": "invalid_tool_call"}])
        out = sanitize_messages([m])
        assert not (out[0].invalid_tool_calls or [])
        assert out[0].tool_calls and out[0].tool_calls[0]["args"] == {}

    def test_healthy_history_is_returned_untouched(self):
        """没坏东西就零改动（同一列表对象）——不能为个别事故给每次调用加拷贝税。"""
        msgs = [HumanMessage(content="写"),
                AIMessage(content="", additional_kwargs={"tool_calls": [{
                    "id": "c", "type": "function",
                    "function": {"name": "write_file", "arguments": '{"path": "a"}'}}]})]
        assert sanitize_messages(msgs) is msgs

    def test_original_message_object_is_not_mutated(self):
        """检查点里的历史要保持原样（审计要看到真实发生过什么）——只改发出去的副本。"""
        sanitize_messages([_BAD_MSG])
        assert _BAD_MSG.additional_kwargs["tool_calls"][0]["function"]["arguments"] == _BAD_ARGS


def test_middleware_is_wired_into_the_deep_agent(monkeypatch):
    """**必须真的挂上**——今天已经第三次栽在"写了但没接上"。"""
    import asyncio

    from agent.agents.bidding_agent.nodes import content as content_mod
    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from agents.bidding_agent.test_content_node import _FakeDeep, _ctx

    seen = {}

    def _capture(**kw):
        seen["middleware"] = kw.get("middleware") or []
        return _FakeDeep({"/chapters/t1.html": {"content": "<p>x</p>"}})

    monkeypatch.setattr(content_mod, "create_deep_agent", _capture)
    asyncio.run(content_mod.make_content_node(_ctx())(
        {"outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
         "read": {}}))
    assert any(isinstance(m, SanitizeToolCallsMiddleware) for m in seen["middleware"]), \
        "deepagent 没挂无害化 middleware——坏参数照样出网，端点照样 400"
