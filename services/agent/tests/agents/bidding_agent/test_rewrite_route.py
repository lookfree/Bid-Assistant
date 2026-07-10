import asyncio
from langgraph.checkpoint.memory import MemorySaver
from agent.runtime.registry import RunContext, get_agent
from agent.agents.bidding_agent.graph import build_bidding_workflow
from agent.routes import chapters as chapters_mod
from agent.routes.chapters import RewriteBody, rewrite

_NEW_HTML = "<h3>3.3 SLA</h3><p>新增分级 SLA 响应时间表…</p>"
_READ_ARGS = {"categories": [], "risk_summary": ["r1"]}


def _use_memory_cp(monkeypatch):
    cp = MemorySaver()

    async def fake_cp():
        return cp
    monkeypatch.setattr(chapters_mod, "get_checkpointer", fake_cp)
    return cp


async def _seed(cp, thread_id: str, chapters: dict):
    """直接向 thread 灌 chapters 状态（不跑节点），返回可读回状态的 graph。"""
    g = build_bidding_workflow(RunContext(run_id="seed", agent_type="bidding_agent",
                                          thread_id=thread_id, checkpointer=cp))
    await g.aupdate_state({"configurable": {"thread_id": thread_id}}, {"chapters": chapters})
    return g


def test_rewrite_updates_single_chapter_keeps_rest(monkeypatch, submit_gateway):
    """spec315a 契约 6：单章改写只更新该章，chapters merge reducer 保其余章。
    先真跑一步 read（thread 有运行历史，与生产一致——aupdate_state 的 as_node 推断需要它），
    再灌 chapters 模拟 content 已产稿。"""
    cp = _use_memory_cp(monkeypatch)
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=_NEW_HTML))
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="th-1",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx):   # 跑到 read 断点
            pass
        g = build_bidding_workflow(ctx)
        cfg = {"configurable": {"thread_id": "th-1"}}
        await g.aupdate_state(cfg, {"chapters": {"t3": "<p>旧 SLA</p>", "t4": "<p>售后</p>"}})
        res = await rewrite("bidding_agent", "th-1",
                            RewriteBody(chapter_id="t3", instruction="补充分级 SLA"))
        snap = await g.aget_state(cfg)
        return res, snap.values, snap.next

    res, values, nxt = asyncio.run(go())
    assert res == {"chapter_id": "t3", "html": _NEW_HTML}
    assert values["chapters"] == {"t3": _NEW_HTML, "t4": "<p>售后</p>"}   # 其余章仍在
    assert nxt == ("outline",)                                           # 改写不改变工作流位置


def test_rewrite_uses_base_html_as_source(monkeypatch, submit_gateway):
    """spec315a code-review：App 传 base_html（DB 里编辑后的现值）时用它作改写底稿，
    不用 agent state 里的旧稿（否则用户编辑被吃掉）；该章仍必须在 state 存在（防乱调）。
    与生产一致先真跑一步 read（rewrite 尾部 aupdate_state 的 as_node 推断需要运行历史）。"""
    cp = _use_memory_cp(monkeypatch)
    seen: list[str] = []
    gw = submit_gateway({}, reply=_NEW_HTML)
    real_get_chat = gw.get_chat

    def spying_get_chat(**kw):
        chat = real_get_chat(**kw)
        orig = chat.ainvoke

        async def ainvoke(messages):
            seen.extend(getattr(m, "content", "") for m in messages if isinstance(getattr(m, "content", ""), str))
            return await orig(messages)

        chat.ainvoke = ainvoke
        return chat

    gw.get_chat = spying_get_chat
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: gw)
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="th-4",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx):   # 跑到 read 断点
            pass
        g = build_bidding_workflow(ctx)
        cfg = {"configurable": {"thread_id": "th-4"}}
        await g.aupdate_state(cfg, {"chapters": {"t3": "<p>state 里的旧稿</p>"}})
        res = await rewrite("bidding_agent", "th-4",
                            RewriteBody(chapter_id="t3", instruction="补充分级 SLA",
                                        base_html="<p>DB 编辑后的底稿</p>"))
        snap = await g.aget_state(cfg)
        return res, snap.values

    res, values = asyncio.run(go())
    assert res == {"chapter_id": "t3", "html": _NEW_HTML}
    joined = "\n".join(seen)
    assert "DB 编辑后的底稿" in joined          # 底稿用的是 base_html
    assert "state 里的旧稿" not in joined       # 不再喂 state 旧值
    assert values["chapters"]["t3"] == _NEW_HTML  # 改写结果照旧同步回 state


def test_rewrite_base_html_still_requires_chapter_in_state(monkeypatch, submit_gateway):
    """带 base_html 也不能绕过「该章在 state 存在」校验。"""
    cp = _use_memory_cp(monkeypatch)
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=_NEW_HTML))

    async def go():
        await _seed(cp, "th-5", {"t1": "<p>一</p>"})
        return await rewrite("bidding_agent", "th-5",
                             RewriteBody(chapter_id="t99", instruction="改", base_html="<p>x</p>"))

    assert asyncio.run(go()).status_code == 404


def test_rewrite_unknown_agent_type_404(monkeypatch, submit_gateway):
    _use_memory_cp(monkeypatch)
    res = asyncio.run(rewrite("no_such_agent", "th-x", RewriteBody(chapter_id="t1", instruction="改")))
    assert res.status_code == 404


def test_rewrite_missing_chapter_404(monkeypatch, submit_gateway):
    cp = _use_memory_cp(monkeypatch)
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=_NEW_HTML))

    async def go():
        await _seed(cp, "th-2", {"t1": "<p>一</p>"})
        return await rewrite("bidding_agent", "th-2", RewriteBody(chapter_id="t99", instruction="改"))

    assert asyncio.run(go()).status_code == 404


def test_rewrite_route_threads_user_id_into_ctx(monkeypatch, submit_gateway):
    """spec316 A2 契约：RewriteBody.user_id → RunContext.user_id（rewrite_chapter 据此判定 RAG 是否生效）。
    先真跑一步 read（同 test_rewrite_updates_single_chapter_keeps_rest：aupdate_state 的 as_node 推断需要运行历史）。"""
    cp = _use_memory_cp(monkeypatch)
    captured = {}

    async def fake_rewrite_chapter(ctx, chapter_id, instruction, state):
        captured["user_id"] = ctx.user_id
        return _NEW_HTML

    monkeypatch.setattr(chapters_mod, "rewrite_chapter", fake_rewrite_chapter)
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=_NEW_HTML))
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="th-6",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx):   # 跑到 read 断点
            pass
        g = build_bidding_workflow(ctx)
        cfg = {"configurable": {"thread_id": "th-6"}}
        await g.aupdate_state(cfg, {"chapters": {"t1": "<p>一</p>"}})
        return await rewrite("bidding_agent", "th-6",
                             RewriteBody(chapter_id="t1", instruction="改", user_id="u-9"))

    res = asyncio.run(go())
    assert res == {"chapter_id": "t1", "html": _NEW_HTML}
    assert captured["user_id"] == "u-9"


def test_rewrite_llm_error_502(monkeypatch):
    cp = _use_memory_cp(monkeypatch)

    class _BoomChat:
        def bind_tools(self, tools, **kw):
            return self

        async def ainvoke(self, messages):
            raise RuntimeError("模型网关不可用")

    class _BoomGateway:
        def get_chat(self, **kw):
            return _BoomChat()

    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: _BoomGateway())

    async def go():
        await _seed(cp, "th-3", {"t1": "<p>一</p>"})
        return await rewrite("bidding_agent", "th-3", RewriteBody(chapter_id="t1", instruction="改"))

    res = asyncio.run(go())
    assert res.status_code == 502
    assert "模型网关不可用" in res.body.decode()
