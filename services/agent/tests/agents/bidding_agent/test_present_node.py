import asyncio
from langchain_core.messages import AIMessage
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import common as common_mod
from agent.agents.bidding_agent.nodes.present import make_present_node


_DECK_ARGS = {"title": "述标", "duration": 15, "template": "gov", "slides": [
    {"id": "s0", "title": "封面", "kind": "cover"},
    {"id": "s1", "title": "运维体系", "bullets": ["7×24"], "notes": "讲稿", "kind": "content"},
], "qa": [{"q": "可用性？", "a": "99.9%"}]}


class _CapGateway:
    """记录发给模型的消息（验证 run_input 注入 prompt），并按给定参数提交 submit_deck。"""

    def __init__(self, deck_args: dict):
        self.deck_args = deck_args
        self.msgs: list = []

    def get_chat(self, **kw):
        gw = self

        class _Chat:
            def bind_tools(self, tools, **kw2):
                self.name = tools[0].name
                return self

            async def ainvoke(self, messages):
                gw.msgs.append(messages)
                return AIMessage(content="", tool_calls=[{"name": self.name, "args": gw.deck_args, "id": "c1"}])
        return _Chat()


def test_present_node_produces_deck_and_pptx_key(monkeypatch, submit_gateway):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"] = key, len(data)

    monkeypatch.setattr(common_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck": _DECK_ARGS}))
    node = make_present_node(ctx)
    out = asyncio.run(node({"chapters": {"t3": "<h3>SLA</h3>"}, "read": {}}))
    assert out["deck"]["template"] == "gov"
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"
    assert saved["key"] == "artifacts/proj-1/present.pptx" and saved["len"] > 0   # 真渲染了 .pptx 字节


def _run_present(monkeypatch, run_input: dict, deck_args: dict):
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    gw = _CapGateway(deck_args)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1", gateway=gw)
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {}, "read": {}, "run_input": run_input}))
    return out, gw.msgs[0][1].content   # HumanMessage 用户消息


def test_present_run_input_duration_and_template(monkeypatch):
    """spec315a 契约 4：run_input.duration/template 注入 prompt；template 提交后强制生效。"""
    out, user = _run_present(monkeypatch, {"duration": 10, "template": "gov"},
                             {**_DECK_ARGS, "template": "blue"})
    assert "时长 10 分钟" in user
    assert "客户指定模板：gov" in user
    assert out["deck"]["template"] == "gov"       # 模型交 blue 也被强制为客户指定


def test_present_run_input_invalid_falls_back(monkeypatch):
    """非法档位/模板回默认：duration=15，template 不注入不强制（保留模型选择）。"""
    out, user = _run_present(monkeypatch, {"duration": 12, "template": "red"}, _DECK_ARGS)
    assert "时长 15 分钟" in user
    assert "客户指定模板" not in user
    assert out["deck"]["template"] == "gov"       # 取自模型提交，未被覆盖
