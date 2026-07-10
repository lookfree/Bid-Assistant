import asyncio
import json
import pytest
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import content as content_mod
from agent.agents.bidding_agent.nodes.common import slim_read


class _FakeDeep:
    """桩 deepagent：ainvoke 直接回预置 files（v2 结构，路径带前导斜杠），绕过真实 LLM 规划。"""

    def __init__(self, files):
        self.files = files

    async def ainvoke(self, _input, config=None):
        return {"messages": [], "files": self.files}


def _ctx():
    return RunContext(run_id="r", agent_type="bidding_agent", thread_id="t")


def test_content_node_collects_chapters(monkeypatch):
    files = {"/chapters/t1.html": {"content": "<h3>1.1 需求理解</h3><p>…</p>", "encoding": "utf-8"},
             "/chapters/b1.html": {"content": "<h3>1.1 投标函</h3><p>…</p>"},
             "/todos.txt": {"content": "无关 key，验证前缀过滤"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _FakeDeep(files))
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": {"chapters": [{"id": "t1"}, {"id": "b1"}]}, "read": {}}))
    assert set(out["chapters"]) == {"t1", "b1"}
    assert out["chapters"]["t1"].startswith("<h3>")


def test_content_node_slims_read_input(monkeypatch):
    """read result 现在并入全文分句 doc_sections 与逐条 source_quote（token 大头）——
    喂给 deepagent 规划轮前必须走 slim_read（与 outline/review 同口径），否则整份招标原文顶穿上下文。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    read = {"categories": [{"key": "technical", "title": "技术需求",
                            "items": [{"title": "SLA 要求", "value": "4h 响应",
                                       "source_quote": "原文大段摘录不该进正文提示词"}]}],
            "doc_sections": [{"id": "sec-1-c1", "text": "全文分句更不该进"}],
            "risk_summary": ["r1"]}
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": {"chapters": [{"id": "t1"}]}, "read": read}))
    assert out["chapters"] == {"t1": "<p>…</p>"}
    assert "SLA 要求" in captured["user"]                      # 白名单字段保留
    assert "r1" in captured["user"]
    assert "doc_sections" not in captured["user"]              # 全文分句被裁
    assert "全文分句更不该进" not in captured["user"]
    assert "原文大段摘录不该进正文提示词" not in captured["user"]  # source_quote 被裁


def test_content_node_fails_loud_when_no_chapters(monkeypatch):
    """deepagent 一章都没写 → 抛错（run 落 failed 可重试），不产假空 chapters。"""
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _FakeDeep({}))
    node = content_mod.make_content_node(_ctx())
    with pytest.raises(RuntimeError, match="chapters"):
        asyncio.run(node({"outline": {}, "read": {}}))


class _FakeRagRetrieve:
    """桩 rag_retrieve 模块：content 节点只用得到 rag_enabled + build_reference_block。"""

    def __init__(self, enabled=True, ref="【参考资料·仅供撰写引用】\n- 片段A"):
        self.enabled = enabled
        self.ref = ref
        self.build_calls: list[tuple] = []

    async def rag_enabled(self, user_id, run_input):
        return self.enabled

    async def build_reference_block(self, user_id, queries, top_k, budget=2000, tender_thread_id=None):
        self.build_calls.append((user_id, queries, top_k, tender_thread_id))
        return self.ref


def test_content_node_injects_reference_block_when_rag_enabled(monkeypatch):
    """spec316 A2 架构现实：content 是 deepagent 一次规划+写完所有章，逐章检索不适配——
    改为用 outline 汇成 queries，全局注入一段参考资料进规划 user 消息。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    fake_rag = _FakeRagRetrieve()
    monkeypatch.setattr(content_mod, "rag_retrieve", fake_rag)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", user_id="u1")
    outline = {"chapters": [{"id": "t1", "title": "需求理解", "items": [{"label": "技术方案"}]}]}
    node = content_mod.make_content_node(ctx)
    asyncio.run(node({"outline": outline, "read": {},
                       "run_input": {"rag": {"enabled": True, "top_k": 5}}}))
    assert "【参考资料·仅供撰写引用】" in captured["user"]
    assert fake_rag.build_calls
    user_id, _queries, top_k, tender_thread_id = fake_rag.build_calls[0]
    assert user_id == "u1" and top_k == 5 and tender_thread_id == "t"


def test_content_node_unchanged_when_rag_disabled(monkeypatch):
    """硬不变式：RAG 不生效（无 user_id）→ user 消息与今天逐字节一致；
    用真实（未打桩）rag_retrieve，验证短路路径本身不发起任何网络调用。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    outline = {"chapters": [{"id": "t1", "title": "需求理解", "items": []}]}
    node = content_mod.make_content_node(_ctx())
    asyncio.run(node({"outline": outline, "read": {}}))
    expected = (f"提纲：\n{json.dumps(outline, ensure_ascii=False)}\n\n"
                f"读标依据：\n{json.dumps(slim_read({}), ensure_ascii=False)}\n\n"
                f"请逐章生成正文，每章写入 chapters/<章id>.html。")
    assert captured["user"] == expected
