import asyncio
from fastapi.responses import JSONResponse
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


def test_rewrite_rejects_the_credentials_appendix_chapter(monkeypatch, submit_gateway):
    """终审 I1 第三道门：sys-creds 是纯代码拼接的确定性附录，App API 已经按库里提纲的
    system 标记挡了一道——这里是最后一道，不管请求怎么绕过来的都要拦住。就地 422，
    不查 thread state、不建 gateway、不碰模型（此前这条路由对这个 id 没有任何特殊处理，
    会像普通章一样把它送进 LLM，把确定性 HTML 改写成幻觉）。"""
    called = {"gateway": False}

    def _spy_gateway(model):
        called["gateway"] = True
        return submit_gateway({}, reply=_NEW_HTML)

    monkeypatch.setattr(chapters_mod, "_make_gateway", _spy_gateway)
    res = asyncio.run(rewrite("bidding_agent", "th-sys", RewriteBody(chapter_id="sys-creds", instruction="补充资质")))
    assert res.status_code == 422
    assert "system_chapter" in res.body.decode()
    assert called["gateway"] is False, "系统章改写走到了建 gateway 这一步——没有在最外层挡住"


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

    async def fake_rewrite_chapter(ctx, chapter_id, instruction, state, **kw):
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


_OUTLINE = {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech",
                          "sourced": True, "items": [{"id": "t1.1", "label": "一、项目理解"}]},
                         {"id": "t6", "no": "第六章", "title": "应急预案", "group": "tech",
                          "sourced": True, "items": [{"id": "t6.1", "label": "一、应急响应"}]}]}


def test_never_generated_chapter_can_be_drafted(monkeypatch, submit_gateway):
    """**正文生成被打断后剩下的章必须能补写**。

    2026-08-08 生产实例：一份标书停在一半，界面把剩下的章标成「待生成」并引导用户去右侧
    AI 助手补写，而这道守卫要求「该章已在 chapters 里」——从没生成过的章当然不在，
    请求在**调模型之前**就被 404 拒掉（观测表里连一次模型调用都没有），
    用户只看到一句「改写失败，请稍后重试」，对着一件做不到的事反复重试。
    """
    cp = _use_memory_cp(monkeypatch)
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=_NEW_HTML))
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r-draft", agent_type="bidding_agent", thread_id="th-draft",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx):   # 先跑到 read 断点，thread 才有运行历史
            pass
        g = build_bidding_workflow(ctx)
        cfg = {"configurable": {"thread_id": "th-draft"}}
        await g.aupdate_state(cfg, {"outline": _OUTLINE})
        await g.aupdate_state(cfg, {"chapters": {"t1": "<p>一</p>"}})   # t6 从未生成
        return await rewrite("bidding_agent", "th-draft",
                             RewriteBody(chapter_id="t6", instruction="按提纲撰写本章正文初稿"))

    res = asyncio.run(go())
    assert not isinstance(res, JSONResponse), f"补写被拒: {getattr(res, 'body', res)}"
    assert res["chapter_id"] == "t6" and res["html"] == _NEW_HTML


def test_chapter_id_outside_the_outline_is_still_rejected(monkeypatch, submit_gateway):
    """放行的只是「提纲里有、正文还没写」的章；提纲里没有的 id 照样拒——
    这道守卫本来就是防拿任意 id 乱调的，不能因为要补写就整个拆掉。"""
    cp = _use_memory_cp(monkeypatch)
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=_NEW_HTML))
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r-bad", agent_type="bidding_agent", thread_id="th-bad",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx):
            pass
        g = build_bidding_workflow(ctx)
        cfg = {"configurable": {"thread_id": "th-bad"}}
        await g.aupdate_state(cfg, {"outline": _OUTLINE})
        await g.aupdate_state(cfg, {"chapters": {"t1": "<p>一</p>"}})
        return await rewrite("bidding_agent", "th-bad", RewriteBody(chapter_id="t99", instruction="写"))

    assert asyncio.run(go()).status_code == 404


def test_outline_chapter_added_after_the_run_can_be_drafted(monkeypatch, submit_gateway):
    """用户在提纲页**新增**的章也要能补写。

    图状态里的 outline 只在跑 run 时刷新，新增章在它里面根本不存在——只认状态就等于
    「提纲新增内容」这类章永远补不了，而空章提示语恰恰写着"该章节为提纲新增内容…建议补写"。
    App 按库里的提纲校验后下发 chapter_title，据此放行。
    """
    cp = _use_memory_cp(monkeypatch)
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=_NEW_HTML))
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r-new", agent_type="bidding_agent", thread_id="th-new",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx):
            pass
        g = build_bidding_workflow(ctx)
        cfg = {"configurable": {"thread_id": "th-new"}}
        await g.aupdate_state(cfg, {"outline": _OUTLINE})          # 状态里的提纲是旧的
        await g.aupdate_state(cfg, {"chapters": {"t1": "<p>一</p>"}})
        return await rewrite("bidding_agent", "th-new",
                             RewriteBody(chapter_id="t99", instruction="写",
                                         chapter_title="第九章 新增的章"))   # 提纲页新加的

    res = asyncio.run(go())
    assert not isinstance(res, JSONResponse), f"新增章被拒: {getattr(res, 'body', res)}"
    assert res["chapter_id"] == "t99"


def test_rewrite_strips_template_disclaimers(monkeypatch, submit_gateway):
    """评审 2026-08-14 F10：免责语的纵深防御必须盖住改写路——旧提示词教出来的
    「本表格式与招标文件模板可能存在差异」若从补齐/改写溜进交付稿，流水线那道清洗白做。"""
    cp = _use_memory_cp(monkeypatch)
    dirty = ("<p><strong>提示：本表格式与招标文件模板可能存在差异，"
             "请对照招标原文核对后使用。</strong></p><p>改写后的正文实质内容。</p>")
    monkeypatch.setattr(chapters_mod, "_make_gateway", lambda m: submit_gateway({}, reply=dirty))
    agent = get_agent("bidding_agent")
    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="th-d",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), checkpointer=cp)

    async def go():
        async for _ in agent.astream({"file_key": "k"}, ctx):
            pass
        g = build_bidding_workflow(ctx)
        await g.aupdate_state({"configurable": {"thread_id": "th-d"}},
                              {"chapters": {"t3": "<p>旧稿</p>"}})
        return await rewrite("bidding_agent", "th-d",
                             RewriteBody(chapter_id="t3", instruction="改写"))

    res = asyncio.run(go())
    assert "可能存在差异" not in res["html"]
    assert "改写后的正文实质内容" in res["html"]
