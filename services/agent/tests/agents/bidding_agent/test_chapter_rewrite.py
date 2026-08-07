import asyncio
from langchain_core.messages import AIMessage
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import content as content_mod
from agent.agents.bidding_agent.nodes.content import rewrite_chapter

_NEW_HTML = "<h3>3.3 服务级别承诺 SLA</h3><p>新增分级 SLA 响应时间表…</p>"


def test_rewrite_chapter_returns_new_html(submit_gateway):
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({}, reply=_NEW_HTML))   # 纯文本回复模式
    state = {"chapters": {"t3": "<h3>3.3 SLA</h3><p>旧…</p>"}}
    html = asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA 响应时间表", state))
    assert "分级 SLA 响应时间表" in html and html.startswith("<h3>")


class _FakeRagRetrieve:
    def __init__(self, enabled=True, ref="【参考资料·仅供撰写引用】\n- 片段A"):
        self.enabled = enabled
        self.ref = ref
        self.build_calls: list[tuple] = []

    async def rag_enabled(self, user_id, run_input):
        return self.enabled

    async def build_reference_block(self, user_id, queries, top_k, budget=2000, tender_thread_id=None):
        self.build_calls.append((user_id, queries, top_k, tender_thread_id))
        return self.ref


class _CapturingChat:
    """记录 ainvoke 收到的完整消息列表（含 BuildMessagesHook 拼的 system+history）。"""

    def __init__(self, reply):
        self.reply = reply
        self.captured = None

    def bind_tools(self, tools, **kw):
        return self

    async def ainvoke(self, messages):
        self.captured = messages
        return AIMessage(content=self.reply)


class _CapturingGateway:
    def __init__(self, reply):
        self.chat = _CapturingChat(reply)

    def get_chat(self, **kw):
        return self.chat


def test_rewrite_chapter_injects_reference_when_rag_enabled(monkeypatch):
    """spec316 A2：rewrite 是真逐章——query 用「原章前 N 字 + 改写指令」检索，命中拼进 msg。"""
    fake_rag = _FakeRagRetrieve()
    monkeypatch.setattr(content_mod, "rag_retrieve", fake_rag)
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=gateway, user_id="u1")
    old = "<h3>3.3 SLA</h3><p>旧…</p>"
    state = {"chapters": {"t3": old}, "run_input": {"rag": {"enabled": True, "top_k": 5}}}
    html = asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA 响应时间表", state))
    assert html == _NEW_HTML
    msg = gateway.chat.captured[-1].content
    assert "【参考资料·仅供撰写引用】" in msg
    assert fake_rag.build_calls
    user_id, _queries, top_k, tender_thread_id = fake_rag.build_calls[0]
    assert user_id == "u1" and top_k == 5 and tender_thread_id == "t"


class _RaisingRag:
    async def rag_enabled(self, user_id, run_input):
        raise RuntimeError("gate boom")

    async def build_reference_block(self, *a, **kw):
        raise AssertionError("gate 抛错时不该走到 build_reference_block")


def test_rewrite_chapter_gate_exception_does_not_break_rewrite(monkeypatch):
    """spec316 A2 harden：rag_enabled 抛错 → 视为 RAG off，改写照常、msg 无 ref。"""
    monkeypatch.setattr(content_mod, "rag_retrieve", _RaisingRag())
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=gateway, user_id="u1")
    old = "<h3>3.3 SLA</h3><p>旧…</p>"
    state = {"chapters": {"t3": old}, "run_input": {"rag": {"enabled": True}}}
    html = asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA", state))
    assert html == _NEW_HTML
    expected = f"原章 HTML：\n{old}\n\n改写指令：补充分级 SLA"
    assert gateway.chat.captured[-1].content == expected


def test_rewrite_chapter_unchanged_when_rag_disabled():
    """硬不变式：RAG 不生效（无 user_id）→ msg 与今天逐字节一致；真实 rag_retrieve 不打桩。"""
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gateway)
    old = "<h3>3.3 SLA</h3><p>旧…</p>"
    state = {"chapters": {"t3": old}}
    asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA 响应时间表", state))
    expected = f"原章 HTML：\n{old}\n\n改写指令：补充分级 SLA 响应时间表"
    assert gateway.chat.captured[-1].content == expected


def test_rewrite_chapter_sends_the_chapter_context(monkeypatch):
    """改写真的把本章上下文发出去了。

    只测 _rewrite_context_block 拼得对是不够的——2026-08-07 变异测试证明：把调用点的
    参数删掉，那些单元测试仍然全绿。这里从实际发给模型的消息里验，堵住"拼好了但没人用"。
    """
    monkeypatch.setattr(content_mod, "rag_retrieve", _FakeRagRetrieve(enabled=False))
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=gateway, user_id="u1")
    state = {
        "chapters": {"t3": "<h3>3.3 SLA</h3><p>旧…</p>"},
        "outline": {"chapters": [
            {"id": "t2", "no": "第二章", "title": "技术方案"},
            # 依据挂在子项上：章本身没有 clause_ids 字段（schemas.OutlineChapter）
            {"id": "t3", "no": "第三章", "title": "服务级别承诺", "desc": "写清分级响应时限",
             "items": [{"label": "3.1 响应时限承诺", "clause_ids": ["sec-5-c1"]}]},
        ]},
        "read": {"categories": [{"key": "business", "title": "商务要求", "items": [
            {"title": "响应时限", "value": "1 小时内到场", "star": True, "clause_ids": ["sec-5-c1"]},
        ]}]},
    }
    asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA 响应时间表", state))
    msg = gateway.chat.captured[-1].content
    assert "第三章 服务级别承诺" in msg          # 本章定位
    assert "写清分级响应时限" in msg             # 提纲里的写作说明
    assert "★" in msg and "响应时限" in msg      # 本章要响应的★条款
    assert "技术方案" in msg                     # 相邻章（防重复）
