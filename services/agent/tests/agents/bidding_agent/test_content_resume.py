"""正文断点续跑（2026-08-08）。

正文是最长最贵的一步。此前内层 deepagent 没挂 checkpointer——进程一死（挂死被杀/发版/崩溃），
已写好的章连同消息历史一起丢，重跑从第一章开始。那天一次挂死白写了 19 章。
deepagents 本来就支持 checkpointer，只是没传。

**最危险的失败法不是"续不上"，是"不该续的时候续了"**：用户改了提纲、换了包件，或者我们改了
提示词，如果还从旧检查点接着跑，交付的是一份按**旧计划**写的标书，而且全程没有任何提示。
"""
import asyncio
from types import SimpleNamespace

import pytest

from agent.agents.bidding_agent.nodes.content import _resume_or_start, content_resume_thread

_CTX = SimpleNamespace(thread_id="proj-1")


_BASE = {"outline": {"chapters": [{"id": "t1", "title": "项目理解"}]},
         "read": {"categories": []}, "run_input": {"package": {"id": "p1"}},
         "writer_prompt": "写手提示词"}


def _tid(ctx=_CTX, **over):
    return content_resume_thread(ctx, **{**_BASE, **over})


class TestThreadId:
    def test_same_input_same_thread(self):
        """输入没变 → 同一个 id → 能接着上次跑。"""
        assert _tid() == _tid()

    @pytest.mark.parametrize("over", [
        {"outline": {"chapters": [{"id": "t1", "title": "项目理解（改过）"}]}},   # 用户改了提纲
        {"run_input": {"package": {"id": "p2"}}},                                # 换了包件
        {"read": {"categories": [{"key": "technical"}]}},                        # 重跑过读标
        {"writer_prompt": "写手提示词 v2"},                                       # 我们改了提示词
    ])
    def test_input_change_invalidates_the_checkpoint(self, over):
        """**输入一变，旧检查点必须自然作废**：否则按旧计划出稿，用户以为改过其实没改。"""
        assert _tid(**over) != _tid()

    def test_retrieval_jitter_does_not_invalidate(self):
        """**反方向同样致命**：检索出来的参考资料每次跑都可能不同，若它进了哈希，
        用户什么都没改、检查点却作废——续跑等于没做。它不改变要写哪些章、写什么要求。"""
        assert _tid() == _tid()   # 参考资料段本就不在入参里，签名即保证

    def test_projects_never_share_a_checkpoint(self):
        assert _tid(ctx=SimpleNamespace(thread_id="proj-2")) != _tid()


class _Deep:
    """记录 ainvoke 收到的是"续跑(None)"还是"从头(messages)"。"""

    def __init__(self, values=None, nxt=()):
        self.snap = SimpleNamespace(values=values or {}, next=nxt)
        self.called_with = "未调用"

    async def aget_state(self, config):
        return self.snap

    async def ainvoke(self, payload, config=None):
        self.called_with = "续跑" if payload is None else "从头"
        return {"files": {}}


def _run(deep):
    asyncio.run(_resume_or_start(deep, "th", "请逐章生成正文", {}))
    return deep.called_with


class TestResume:
    def test_no_checkpoint_starts_fresh(self):
        assert _run(_Deep()) == "从头"

    def test_half_written_run_resumes(self):
        """已写了几章 → 接着写，别从第一章重来。"""
        assert _run(_Deep(values={"files": {"/chapters/t1.html": {"content": "<p>已写</p>"}}})) == "续跑"

    def test_pending_node_resumes(self):
        assert _run(_Deep(values={"messages": []}, nxt=("agent",))) == "续跑"

    def test_resume_must_not_resend_the_instruction(self):
        """续跑必须用 None 作输入。再传一次 messages 会往历史里追加同样的指令，
        模型看到两条"请逐章生成正文"，很可能把已写好的章重写一遍——正是要省掉的开销。"""
        deep = _Deep(values={"files": {"/chapters/t1.html": {"content": "x"}}})
        asyncio.run(_resume_or_start(deep, "th", "请逐章生成正文", {}))
        assert deep.called_with == "续跑"


def test_checkpointer_is_actually_passed_to_the_deep_agent(monkeypatch):
    """**checkpointer 必须真的传给 deepagent**。

    只测辅助函数是不够的：那两个函数写得再对，构造 deepagent 时不传 checkpointer，
    线上依旧一死全丢。今天已经有两次"写了但没接上"了（超时加在没人走的路径上、
    清洗函数接了两头没接中间），这条专门守它。
    """
    import asyncio as aio

    from agent.agents.bidding_agent.nodes import content as content_mod
    from .test_content_node import _FakeDeep, _ctx

    seen = {}

    def _capture(**kw):
        seen.update(kw)
        return _FakeDeep({"/chapters/t1.html": {"content": "<p>x</p>"}})

    monkeypatch.setattr(content_mod, "create_deep_agent", _capture)
    ctx = _ctx()
    object.__setattr__(ctx, "checkpointer", "标记：这就是 ctx 上的 checkpointer")
    aio.run(content_mod.make_content_node(ctx)(
        {"outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
         "read": {}}))
    assert seen.get("checkpointer") == "标记：这就是 ctx 上的 checkpointer", \
        "deepagent 没拿到 checkpointer——一死全丢，续跑无从谈起"


class TestGeneration:
    """**该不该续，由"第几次生成"表达，不再单开意图开关。**

    重试时这个数不变（接得上刚写了一半的检查点）；重新生成时 +1（换一条干净的线）。
    此前用布尔"是不是重新生成"，而它靠"上一条是不是 done"推断——一次重新生成失败之后
    那个推断会翻转，重试就接到上一次**已完成**的检查点上，`ainvoke(None)` 一步不跑，
    把旧稿当新结果交回来：用户付了钱拿回同一份文档（2026-08-08 审查提出）。
    """

    def test_regeneration_gets_a_new_lineage(self):
        first = _tid(run_input={"content_generation": 0})
        second = _tid(run_input={"content_generation": 1})
        assert first != second

    def test_retry_of_a_failed_regeneration_resumes_it(self):
        """**关键**：重新生成失败后重试，算出的必须还是那条线——
        不然就回落到上一次已完成的检查点，把旧文档当新结果交回来。"""
        a = _tid(run_input={"content_generation": 1})
        b = _tid(run_input={"content_generation": 1})
        assert a == b
        assert a != _tid(run_input={"content_generation": 0})

    def test_first_generation_has_no_suffix(self):
        """第一次生成不加后缀：老项目（App 尚未下发这个字段）算出的 id 与从前一致，
        它们已有的检查点不会因为这次改动全部失效。"""
        assert _tid(run_input={}) == _tid(run_input={"content_generation": 0})

def test_node_uses_the_generation_from_run_input(monkeypatch):
    """**App 下发的"第几次生成"必须真的进到 thread id**。

    算得再对，节点不把它传进去也是白搭——今天已经栽过好几次"写了但没接上"
    （超时加在没人走的路径、清洗接了两头没接中间）。
    """
    import asyncio as aio

    from agent.agents.bidding_agent.nodes import content as content_mod
    from .test_content_node import _FakeDeep, _ctx

    seen = {}

    class _Deep(_FakeDeep):
        checkpointer = object()

        async def aget_state(self, config):
            seen.setdefault("threads", []).append(config["configurable"]["thread_id"])
            return SimpleNamespace(values={}, next=())

        async def ainvoke(self, payload, config=None):
            return await super().ainvoke({"messages": []}, config=config)

    monkeypatch.setattr(content_mod, "create_deep_agent",
                        lambda **kw: _Deep({"/chapters/t1.html": {"content": "<p>x</p>"}}))
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]}
    for gen in (0, 1):
        aio.run(content_mod.make_content_node(_ctx())(
            {"outline": outline, "read": {}, "run_input": {"content_generation": gen}}))
    a, b = seen["threads"]
    assert a != b, "两次生成用了同一条检查点线路——第二次会把上一份成稿当新结果交回来"
    assert b.endswith("-g1")


class TestReviewFindings:
    """审查（2026-08-08）挑出的四点，前两条都会真正伤到用户。"""

    def test_thread_never_depends_on_the_run(self):
        """**不能用 run_id 做盐**：每次执行都换 id，就永远接不上上一次的检查点。"""
        a = content_resume_thread(SimpleNamespace(thread_id="p", run_id="run-1"), **_BASE)
        b = content_resume_thread(SimpleNamespace(thread_id="p", run_id="run-2"), **_BASE)
        assert a == b

    def test_fill_missing_runs_on_the_same_lineage(self):
        """补漏章必须跑在**同一条血缘**上：主轮挂了自定义 thread 之后，补写若不带同一个 id，
        读到的是空状态——没有招标原文、没有提纲、也不知道写过哪几章，只能凭空编。"""
        import inspect

        from agent.agents.bidding_agent.nodes.content import _fill_missing_chapters, make_content_node

        assert "thread_id" in inspect.signature(_fill_missing_chapters).parameters
        src = inspect.getsource(_fill_missing_chapters)
        assert 'cfg["configurable"] = {"thread_id": thread_id}' in src
        assert "resume_thread" in inspect.getsource(make_content_node), "主轮没把 thread 传给补写"

    def test_resume_seeds_the_progress_counter(self):
        """续跑时进度要从检查点里已写的章起算，否则崩在第 19 章的任务重试时
        横幅从"已完成 0/20"开始爬，用户以为又从头来了。"""
        from agent.agents.bidding_agent.nodes.content import ChapterProgressCallback

        cb = ChapterProgressCallback(SimpleNamespace(redis=None, run_id=None, recorder=None),
                                     total=20, titles={f"t{i}": str(i) for i in range(1, 21)})
        cb.seed_done({f"/chapters/t{i}.html": {"content": "x"} for i in range(1, 20)})
        assert len(cb.done) == 19
        cb.seed_done({"/chapters/t1.html": {"content": "x"}})     # 幂等，不重复计
        assert len(cb.done) == 19
        cb.seed_done({"/chapters/幽灵.html": {"content": "x"}})    # 提纲里没有的不计
        assert len(cb.done) == 19


class TestBrokenHistory:
    """**坏历史绝不继承**（2026-08-08 线上实测）。

    某一轮的 write_todos 被拒（参数类型问题，仓库里 2026-08-06 就记过这个老毛病），
    状态里留下一个"执行不了"的悬空工具调用。用户点重试，新指令接在这份坏历史后面——
    再失败一次，点几次坏几次。挂 checkpointer 本身没引入这个失败，但**把一次偶发变成了持续**：
    回滚前每轮新建 namespace，坏历史随手丢掉，重试天然干净。续跑必须保住那份干净。
    """

    def _msg(self, text):
        return SimpleNamespace(content=text)

    def test_dangling_tool_call_counts_as_broken(self):
        from agent.agents.bidding_agent.nodes.content import _history_is_broken

        broken = {"messages": [self._msg("提纲…"), self._msg(""),
                               self._msg("Tool call write_todos with id call_x could not be executed")]}
        assert _history_is_broken(broken) is True

    def test_healthy_history_is_kept(self):
        from agent.agents.bidding_agent.nodes.content import _history_is_broken

        assert _history_is_broken({"messages": [self._msg("提纲…"), self._msg("已写入 t1")]}) is False
        assert _history_is_broken({"messages": []}) is False
        assert _history_is_broken({}) is False

    def test_old_failure_already_worked_around_is_not_broken(self):
        """更早的失败若已被后续轮次绕过去，不该因此丢掉整条进度——只看末尾几条。"""
        from agent.agents.bidding_agent.nodes.content import _history_is_broken

        values = {"messages": [self._msg("could not be executed")] + [self._msg(f"第{i}章写完") for i in range(5)]}
        assert _history_is_broken(values) is False

    def test_broken_history_switches_lineage_not_just_restarts(self):
        """**接线**：判出坏历史后必须**换一条线**，不是在原线上重发指令。

        第一版只做了"从头跑"却留在同一条 thread 上——langgraph 把新输入并进旧状态，
        坏消息照样进请求，端点照样 400（2026-08-08 生产实证：关了流式重试仍 400，
        因为病根是库里的坏历史）。换线的盐取坏检查点 id：同一份坏历史永远派生同一条新线，
        新线写一半失败，下次重试还能找到它接着写。
        """
        import asyncio

        calls = []

        class _Deep:
            async def aget_state(self, config):
                tid = config["configurable"]["thread_id"]
                calls.append(tid)
                if tid == "th":       # 主线：坏历史
                    return SimpleNamespace(
                        values={"messages": [SimpleNamespace(content="write_todos could not be executed")]},
                        next=("model",),
                        config={"configurable": {"checkpoint_id": "ckpt1234abcd"}})
                return SimpleNamespace(values={}, next=(), config={})   # 新线：干净

            async def ainvoke(self, payload, config=None):
                calls.append(("invoke", "续跑" if payload is None else "从头",
                              config["configurable"]["thread_id"]))
                return {"files": {}}

        asyncio.run(_resume_or_start(_Deep(), "th", "请逐章生成正文",
                                     {"configurable": {"thread_id": "th"}}))
        kind, mode, tid = calls[-1]
        assert mode == "从头"
        assert tid == "th-rckpt1234", f"没换线路（{tid}）——坏历史照样被并进请求"

    def test_same_broken_history_always_derives_the_same_new_lineage(self):
        """盐必须稳定：新线写了一半失败，重试要能找到同一条线接着写。"""
        import asyncio

        class _Deep:
            def __init__(self):
                self.seen = []

            async def aget_state(self, config):
                tid = config["configurable"]["thread_id"]
                self.seen.append(tid)
                if tid == "th":
                    return SimpleNamespace(
                        values={"messages": [SimpleNamespace(content="could not be executed")]},
                        next=(), config={"configurable": {"checkpoint_id": "ckptAAAA1111"}})
                # 新线上已有半截进度 → 应当续跑
                return SimpleNamespace(values={"files": {"/chapters/t1.html": {"content": "x"}}},
                                       next=("agent",), config={})

            async def ainvoke(self, payload, config=None):
                self.mode = "续跑" if payload is None else "从头"
                return {"files": {}}

        d = _Deep()
        asyncio.run(_resume_or_start(d, "th", "写", {"configurable": {"thread_id": "th"}}))
        assert d.seen[-1] == "th-rckptAAAA"
        assert d.mode == "续跑", "换线后没接上新线里已写的章——盐不稳定就永远从零开始"
