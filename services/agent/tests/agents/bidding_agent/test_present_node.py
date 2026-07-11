import asyncio
import pytest
from langchain_core.messages import AIMessage
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import common as common_mod
from agent.agents.bidding_agent.nodes.present import make_present_node


_DRAFT_ARGS = {"title": "述标", "duration": 15, "template": "gov", "slides": [
    {"id": "s0", "title": "封面", "kind": "cover"},
    {"id": "s1", "title": "运维体系", "bullets": ["7×24"], "kind": "content"},
], "qa": [{"q": "可用性？", "a": "99.9%"}]}

_NOTES_ARGS = {"notes": [
    {"id": "s0", "notes": "开场白"},
    {"id": "s1", "notes": "讲稿"},
]}


class _CapGateway:
    """记录发给模型的消息（验证 run_input 注入 prompt），按工具名分派 draft/notes 两套提交参数。"""

    def __init__(self, draft_args: dict, notes_args: dict | None = None):
        self.draft_args = draft_args
        self.notes_args = notes_args or _NOTES_ARGS
        self.msgs: list = []

    def get_chat(self, **kw):
        gw = self

        class _Chat:
            def bind_tools(self, tools, **kw2):
                self.name = tools[0].name
                return self

            async def ainvoke(self, messages):
                gw.msgs.append(messages)
                args = gw.draft_args if self.name == "submit_deck_draft" else gw.notes_args
                return AIMessage(content="", tool_calls=[{"name": self.name, "args": args, "id": "c1"}])
        return _Chat()


def test_present_node_produces_deck_and_pptx_key(monkeypatch, submit_gateway):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"] = key, len(data)

    monkeypatch.setattr(common_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    node = make_present_node(ctx)
    out = asyncio.run(node({"chapters": {"t3": "<h3>SLA</h3>"}, "read": {}}))
    assert out["deck"]["template"] == "gov"
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"
    assert saved["key"] == "artifacts/proj-1/present.pptx" and saved["len"] > 0   # 真渲染了 .pptx 字节


def test_present_merges_notes_by_slide_id(monkeypatch, submit_gateway):
    """两段合并正确：draft 2 页 + notes 覆盖两页 → notes 来自 notes 段、qa/template 来自 draft 段。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))
    notes_by_id = {s["id"]: s["notes"] for s in out["deck"]["slides"]}
    assert notes_by_id == {"s0": "开场白", "s1": "讲稿"}
    assert out["deck"]["qa"] == [{"q": "可用性？", "a": "99.9%"}]
    assert out["deck"]["template"] == "gov"


def test_present_missing_slide_notes_falls_back_to_empty(monkeypatch, submit_gateway):
    """缺页 notes 兜底：notes 段只覆盖 s1，漏 s0 → s0 的 notes 为空串，不报错，仍出 pptx。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    partial_notes = {"notes": [{"id": "s1", "notes": "讲稿"}]}
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": partial_notes}))
    out = asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))
    notes_by_id = {s["id"]: s["notes"] for s in out["deck"]["slides"]}
    assert notes_by_id == {"s0": "", "s1": "讲稿"}
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"


@pytest.mark.parametrize("empty_notes", [{}, {"notes": []}])
def test_present_notes_pass_all_empty_submission_fails_closed(monkeypatch, submit_gateway, empty_notes):
    """口播稿段整段放弃（提交 {} 缺字段，或 {"notes": []} 空列表）→ SlideNotes 校验失败(必填+min_length=1)、
    重试耗尽 → present_node 抛 RuntimeError，而非静默把整份 deck 的 notes 全置空当成功（Task A 安全网保留）。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": empty_notes}))
    with pytest.raises(RuntimeError):
        asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))


def _run_present(monkeypatch, run_input: dict, draft_args: dict):
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    gw = _CapGateway(draft_args)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1", gateway=gw)
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {}, "read": {}, "run_input": run_input}))
    return out, gw.msgs[0][1].content   # HumanMessage 用户消息（骨架段第一轮）


def test_present_run_input_duration_and_template(monkeypatch):
    """spec315a 契约 4：run_input.duration/template 注入 prompt；template 提交后强制生效。"""
    out, user = _run_present(monkeypatch, {"duration": 10, "template": "gov"},
                             {**_DRAFT_ARGS, "template": "blue"})
    assert "时长 10 分钟" in user
    assert "客户指定模板：gov" in user
    assert out["deck"]["template"] == "gov"       # 模型交 blue 也被强制为客户指定


def test_present_run_input_invalid_falls_back(monkeypatch):
    """非法档位/模板回默认：duration=15，template 不注入不强制（保留模型选择）。"""
    out, user = _run_present(monkeypatch, {"duration": 12, "template": "red"}, _DRAFT_ARGS)
    assert "时长 15 分钟" in user
    assert "客户指定模板" not in user
    assert out["deck"]["template"] == "gov"       # 取自模型提交，未被覆盖


def test_present_enterprise_template_key_fetches_master_and_sets_deck_id(monkeypatch, submit_gateway):
    """企业母版：run_input.enterprise_template_key 给出 → 预取字节（storage_read.read_bytes）
    并传给 render_pptx 的 master_bytes；deck.enterprise_template_id 写回同一 key。"""
    from agent.parsing import storage_read as storage_read_mod
    from agent.agents.bidding_agent.nodes import present as present_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    fetched = []
    monkeypatch.setattr(storage_read_mod, "read_bytes",
                        lambda key: fetched.append(key) or b"fake-master-bytes")
    captured = {}

    def _fake_render_pptx(deck, *, template=None, master_bytes=None):
        captured["master_bytes"] = master_bytes
        return b"PK\x03\x04fake"
    monkeypatch.setattr(present_mod, "render_pptx", _fake_render_pptx)

    key = "library/u1/master.pptx"
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {}, "read": {}, "run_input": {"enterprise_template_key": key}}))
    assert fetched == [key]
    assert captured["master_bytes"] == b"fake-master-bytes"
    assert out["deck"]["enterprise_template_id"] == key


def test_present_enterprise_template_fetch_failure_falls_back_blank(monkeypatch, submit_gateway):
    """取母版字节失败（网络抖动/坏 key）→ master_bytes=None 传给 render_pptx，不抛错；
    deck.enterprise_template_id 仍写回 key（供 export 之后重试）。"""
    from agent.parsing import storage_read as storage_read_mod
    from agent.agents.bidding_agent.nodes import present as present_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    def _raising_read_bytes(key):
        raise RuntimeError("object not found")
    monkeypatch.setattr(storage_read_mod, "read_bytes", _raising_read_bytes)
    captured = {}

    def _fake_render_pptx(deck, *, template=None, master_bytes=None):
        captured["master_bytes"] = master_bytes
        return b"PK\x03\x04fake"
    monkeypatch.setattr(present_mod, "render_pptx", _fake_render_pptx)

    key = "library/u1/missing.pptx"
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {}, "read": {}, "run_input": {"enterprise_template_key": key}}))
    assert captured["master_bytes"] is None
    assert out["deck"]["enterprise_template_id"] == key


def test_present_without_enterprise_template_key_unchanged(monkeypatch, submit_gateway):
    """没有 enterprise_template_key（今天的行为）→ master_bytes=None，deck.enterprise_template_id
    保持模型提交的默认值 None，不因新增功能改变现有产出。"""
    from agent.agents.bidding_agent.nodes import present as present_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())
    captured = {}

    def _fake_render_pptx(deck, *, template=None, master_bytes=None):
        captured["master_bytes"] = master_bytes
        return b"PK\x03\x04fake"
    monkeypatch.setattr(present_mod, "render_pptx", _fake_render_pptx)

    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))
    assert captured["master_bytes"] is None
    assert out["deck"]["enterprise_template_id"] is None
