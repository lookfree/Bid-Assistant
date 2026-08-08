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
        self.finish_reason = "stop"

    def bind_tools(self, tools, **kw):
        return self

    async def ainvoke(self, messages):
        self.captured = messages
        return AIMessage(content=self.reply, response_metadata={"finish_reason": self.finish_reason})


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


def test_rewrite_refuses_a_truncated_output(monkeypatch):
    """输出被长度上限截断时拒收，绝不整章覆盖。

    改写是**整章替换**，而校验只看「含不含标签」——截断的 HTML 照样过关，用户这一章的后半部分
    就这么没了。信号一直有：agent.agent_token_usage 里 finish_reason='length' 实测发生过 53 次。
    """
    import pytest

    monkeypatch.setattr(content_mod, "rag_retrieve", _FakeRagRetrieve(enabled=False))
    gateway = _CapturingGateway("<h3>只写了开头</h3><p>后面被截断")
    gateway.chat.finish_reason = "length"
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gateway, user_id="u1")
    state = {"chapters": {"t3": "<h3>3.3 SLA</h3><p>很长的原文…</p>"}}
    with pytest.raises(RuntimeError, match="rewrite_truncated"):
        asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA 响应时间表", state))


def test_normal_finish_is_accepted(monkeypatch):
    """正常收尾（stop）不能被误伤。"""
    monkeypatch.setattr(content_mod, "rag_retrieve", _FakeRagRetrieve(enabled=False))
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gateway, user_id="u1")
    html = asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA", {"chapters": {"t3": "<p>旧</p>"}}))
    assert html == _NEW_HTML


def test_empty_chapter_gets_a_drafting_prompt_not_a_rewrite_one(monkeypatch):
    """本章还没有正文时要**写初稿**，不是"改写空白"。

    正文生成被打断是常态（实测一份 20 章的标书停在第 14 章），剩下的章在界面上标着「待生成」。
    改写提示词从头到尾只说"仅就当前章按用户指令改写"，手里却没有原章——模型无从下手，
    而页面的空章提示语写的是"由 AI 生成/改写本章正文"，等于让用户去做一件后端不支持的事。
    """
    monkeypatch.setattr(content_mod, "rag_retrieve", _FakeRagRetrieve(enabled=False))
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gateway)
    state = {
        "chapters": {"t3": ""},                        # 本章从未生成
        "outline": {"chapters": [{"id": "t3", "no": "第三章", "title": "应急预案",
                                  "items": [{"label": "一、应急响应流程"}]}]},
        "read": {"categories": []},
    }
    asyncio.run(rewrite_chapter(ctx, "t3", "", state))
    msgs = gateway.chat.captured
    system = msgs[0].content
    user = msgs[-1].content
    assert "子写手" in system, "空章仍在用改写提示词，模型手里没有原章可改"
    # 收稿口径必须对：补写没绑任何工具，回复正文就是交稿。用带 write_file 的那版提示词，
    # 听话的模型会回「已写入 chapters/t6.html」，App 校验「必须含 HTML 标签」判 502——
    # 正是补写要修的那个失败（2026-08-08 审查抓到，假网关无论什么提示词都回 HTML，测不出来）。
    assert "write_file" not in system, "补写用了写文件收稿的提示词，模型不会把正文放回消息里"
    assert "首字符必须是 '<'" in system
    assert "改写指令" not in user, "空章不该再拼「改写指令」段"
    assert "第三章 应急预案" in user               # 本章定位仍要给
    assert "尚未生成" in user


def test_drafting_still_honours_a_user_instruction(monkeypatch):
    """用户在助手里给了具体要求时，补写要照办——批量补齐时指令为空，也不能硬塞一句空要求。"""
    monkeypatch.setattr(content_mod, "rag_retrieve", _FakeRagRetrieve(enabled=False))
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gateway)
    state = {"chapters": {"t3": ""}, "read": {"categories": []},
             "outline": {"chapters": [{"id": "t3", "no": "第三章", "title": "应急预案"}]}}
    asyncio.run(rewrite_chapter(ctx, "t3", "重点写 2 小时到场承诺", state))
    assert "重点写 2 小时到场承诺" in gateway.chat.captured[-1].content


def test_existing_chapter_still_uses_the_rewrite_prompt(monkeypatch):
    """有正文的章行为不变——补写不能顺手把改写也改了。"""
    monkeypatch.setattr(content_mod, "rag_retrieve", _FakeRagRetrieve(enabled=False))
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gateway)
    state = {"chapters": {"t3": "<p>已有正文</p>"}, "read": {"categories": []},
             "outline": {"chapters": [{"id": "t3", "no": "第三章", "title": "应急预案"}]}}
    asyncio.run(rewrite_chapter(ctx, "t3", "改得更正式", state))
    assert "润色专家" in gateway.chat.captured[0].content
    assert "改写指令：改得更正式" in gateway.chat.captured[-1].content


def test_drafting_retrieves_by_chapter_not_by_the_boilerplate_instruction(monkeypatch):
    """补写的检索词要用本章标题/条目，不是那句模板指令。

    改写时查询是「原章前 N 字 + 指令」；补写时原章是空的，而批量补齐给每章发的是同一句
    "请按提纲与招标要求撰写本章正文初稿"——照搬就等于每一章都拿同一个与章节无关的词去检索，
    参考资料对谁都不切题。
    """
    rag = _FakeRagRetrieve(enabled=True)
    monkeypatch.setattr(content_mod, "rag_retrieve", rag)
    gateway = _CapturingGateway(_NEW_HTML)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gateway, user_id="u1")
    state = {
        "chapters": {"t3": ""},
        "run_input": {"rag": {"enabled": True}},
        "read": {"categories": []},
        "outline": {"chapters": [{"id": "t3", "no": "第三章", "title": "应急预案",
                                  "items": [{"label": "一、应急响应流程"}]}]},
    }
    asyncio.run(rewrite_chapter(ctx, "t3", "本章尚无正文，请按提纲与招标要求撰写本章正文初稿", state))
    query = " ".join(rag.build_calls[-1][1])
    assert "应急预案" in query and "应急响应流程" in query, f"检索词没用上本章信息: {query!r}"
    assert "请按提纲与招标要求撰写" not in query, f"检索词是那句模板指令: {query!r}"
