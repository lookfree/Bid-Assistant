"""正文代码编排引擎（任务 #84）。

2026-08-08 一个下午没能完整交付一份标书，全部事故同一个根：编排权在模型手里。
这里守的是新引擎的编排不变式——章清单来自提纲、并发受限、每章落断点、残章重试、
缺章如实缺而不是整步崩。
"""
import asyncio

import pytest
from langchain_core.messages import AIMessage

from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline
from agent.config import settings


class _FakeRedis:
    def __init__(self):
        self.kv: dict = {}
        self.streams: list = []

    def get(self, k):
        return self.kv.get(k)

    def set(self, k, v, ex=None):
        self.kv[k] = v

    def xadd(self, key, fields):
        self.streams.append(fields)

    def pipeline(self):
        raise RuntimeError("测试不该走到这")


class _FakeChat:
    """假模型：记录并发峰值与每次调用的消息；按章标题回不同正文；可指定某章持续吐残稿。"""

    def __init__(self, bad_ids=(), delay=0.02):
        self.bad_ids = set(bad_ids)
        self.delay = delay
        self.calls = 0
        self.now = 0
        self.peak = 0
        self.seen: list = []   # 每次调用的 (system, user) 消息内容——注入类断言用

    async def ainvoke(self, msgs, config=None):
        self.calls += 1
        self.now += 1
        self.peak = max(self.peak, self.now)
        self.seen.append((msgs[0].content, msgs[-1].content))
        await asyncio.sleep(self.delay)
        self.now -= 1
        user = msgs[-1].content
        tail = user.split("请撰写本章")[-1]   # 只看点名行：相邻章列表里也会出现别章标题
        bad = next((b for b in self.bad_ids if b in tail), None)
        if bad:
            return AIMessage(content="太短")
        return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")


def _brief_of(chat: "_FakeChat", title: str) -> str:
    """按点名行找到某章那次调用的 user 消息（简报）。"""
    return next(u for _, u in chat.seen if title in u.split("请撰写本章")[-1])


def _ctx(redis=None):
    from types import SimpleNamespace
    return SimpleNamespace(thread_id="proj-t", run_id="r1", redis=redis, gateway=object(),
                           recorder=None, user_id=None)


def _state(n=6):
    return {"outline": {"chapters": [
        {"id": f"t{i}", "no": f"第{i}章", "title": f"章节{i}", "group": "tech", "items": []}
        for i in range(1, n + 1)]},
        "read": {"categories": []}, "run_input": {}}


def _run(state, chat, redis=None, monkeypatch=None):
    from agent.agents.bidding_agent.nodes import content_pipeline as mod
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat)
    return asyncio.run(run_content_pipeline(_ctx(redis), state))


class TestPipeline:
    def test_all_chapters_from_the_outline_get_written(self, monkeypatch):
        """章清单来自提纲——不靠模型记忆，一章都不能少。"""
        chat = _FakeChat()
        out = _run(_state(6), chat, monkeypatch=monkeypatch)
        assert set(out) == {f"t{i}" for i in range(1, 7)}
        assert all("<h3>" in v for v in out.values())

    def test_concurrency_never_exceeds_the_cap(self, monkeypatch):
        """并发上限由代码保证——旧引擎 15 路自堵正是没有这道闸。"""
        monkeypatch.setattr(settings, "model_content_max_parallel", 3)
        chat = _FakeChat()
        _run(_state(12), chat, monkeypatch=monkeypatch)
        assert chat.peak <= 3, f"并发峰值 {chat.peak} 超过上限 3"

    def test_finished_chapters_resume_from_cache(self, monkeypatch):
        """每章写完落 Redis 断点：重试只补缺章，不为已写好的章再花一分钱。"""
        redis = _FakeRedis()
        chat1 = _FakeChat()
        _run(_state(4), chat1, redis=redis, monkeypatch=monkeypatch)
        assert chat1.calls == 4
        chat2 = _FakeChat()
        out = _run(_state(4), chat2, redis=redis, monkeypatch=monkeypatch)
        assert chat2.calls == 0, "断点没命中——重试把已写好的章又写了一遍"
        assert len(out) == 4

    def test_outline_change_invalidates_the_cache(self, monkeypatch):
        """提纲改了 → 简报变 → 键变 → 旧稿自然作废（照抄分段读标的提示词哈希手法）。"""
        redis = _FakeRedis()
        _run(_state(2), _FakeChat(), redis=redis, monkeypatch=monkeypatch)
        changed = _state(2)
        changed["outline"]["chapters"][0]["title"] = "改过的标题"
        chat2 = _FakeChat()
        _run(changed, chat2, redis=redis, monkeypatch=monkeypatch)
        assert chat2.calls >= 1, "提纲改了还全用旧稿——按旧计划交付"

    def test_retry_recovers_a_flaky_chapter(self, monkeypatch):
        """第一次吐残稿、第二次正常——重试就该把它救回来，不能一次残就记缺章。"""

        class _FlakyChat(_FakeChat):
            def __init__(self):
                super().__init__()
                self.flaked = False

            async def ainvoke(self, msgs, config=None):
                tail = msgs[-1].content.split("请撰写本章")[-1]
                if "章节2" in tail and not self.flaked:
                    self.flaked = True
                    self.calls += 1
                    return AIMessage(content="太短")
                return await super().ainvoke(msgs, config)

        out = _run(_state(3), _FlakyChat(), monkeypatch=monkeypatch)
        assert "t2" in out, "一次残稿就被记成缺章——重试没生效"
        assert len(out) == 3

    def test_a_stubborn_bad_chapter_is_missing_not_fatal(self, monkeypatch):
        """某章两次都吐残稿 → 如实缺章（前端免费补齐），**其它章照常交付**——
        旧引擎是一处失败全盘皆输。"""
        chat = _FakeChat(bad_ids={"章节3"})
        out = _run(_state(5), chat, monkeypatch=monkeypatch)
        assert "t3" not in out and len(out) == 4

    def test_progress_events_carry_exact_counts(self, monkeypatch):
        """进度不再靠回调猜——写完就是写完。事件形状与旧引擎一致，前端零改动。"""
        redis = _FakeRedis()
        _run(_state(3), _FakeChat(), redis=redis, monkeypatch=monkeypatch)
        import json as _json
        dones = [_json.loads(f["event"])["data"] for f in redis.streams
                 if "chapter" in str(f.get("event"))]
        assert [d["done"] for d in dones] == [1, 2, 3]
        assert dones[-1]["total"] == 3


class TestBriefTargeting:
    """按需注入：偏离表条目只发给偏离表章、招标格式模板只发给被点名的格式章——
    整轮全量重发正是旧引擎 36:1 输入比的来源（#85 删旧引擎时从 test_content_node 移植）。"""

    def _state_with_deviation(self):
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "技术偏离表"
        state["read"] = {"categories": [
            {"key": "technical", "title": "技术", "items": [
                {"title": "最高限价", "value": "96万元", "star": True, "clause_ids": ["sec-19-c129"]}]}],
            "doc_headings": [{"sec": "sec-19", "title": "第五章 技术规范书", "level": 1}]}
        return state

    def test_deviation_items_go_only_to_the_deviation_chapter(self, monkeypatch):
        chat = _FakeChat()
        _run(self._state_with_deviation(), chat, monkeypatch=monkeypatch)
        dev = _brief_of(chat, "技术偏离表")
        other = _brief_of(chat, "章节2")
        assert "偏离表指引" in dev and "最高限价" in dev
        assert "偏离表指引" not in other, "偏离表全量条目发给了无关章——重蹈整轮重发"

    def test_no_internal_clause_id_reaches_any_brief(self, monkeypatch):
        """内部条款 id（sec-N-cM）只在提纲步进出模型，其余步喂之前剥掉——模型看得见就会写进
        交付文档（2026-08-08 用户截图：偏离表整列 sec-19-c129）。逐章简报同样守这条边界。"""
        import re
        chat = _FakeChat()
        _run(self._state_with_deviation(), chat, monkeypatch=monkeypatch)
        for _, user in chat.seen:
            assert not re.search(r"sec-\d+-c\d+", user), f"简报里泄漏了内部条款 id：{user[:200]}"
        assert "第五章 技术规范书" in _brief_of(chat, "技术偏离表")   # 出处列有真数据可填

    def test_tender_template_goes_only_to_the_named_form_chapter(self, monkeypatch):
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "投标函格式"
        state["outline"]["chapters"][0]["structure_ref"] = "s1"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "投标函", "clause_ids": ["sec-8-c1"]}]
        state["read"] = {"required_structure": [{"id": "s1", "title": "投标函", "kind": "form",
                                                 "clause_ids": ["sec-8-c1"]}],
                         "doc_sections": [{"id": "sec-8-c1", "text": "致：（招标人名称）我方参加贵方组织的投标"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "招标格式模板" in _brief_of(chat, "投标函格式")
        assert "招标格式模板" not in _brief_of(chat, "章节2"), "格式模板发给了无关章"


class TestReferenceInjection:
    """RAG 参考资料段（spec316）：启用则每章简报带；检索故障绝不阻断正文生成（降级铁律）。"""

    def _patch_rag(self, monkeypatch, enabled=True, boom=False):
        from agent.agents.bidding_agent.nodes import content as content_mod

        class _Rag:
            @staticmethod
            async def rag_enabled(user_id, run_input):
                if boom:
                    raise RuntimeError("rag down")
                return enabled

            @staticmethod
            async def build_reference_block(user_id, queries, top_k, tender_thread_id=None):
                return "【参考资料】历史标书片段…"

        monkeypatch.setattr(content_mod, "rag_retrieve", _Rag)

    def test_reference_block_reaches_every_brief_when_enabled(self, monkeypatch):
        self._patch_rag(monkeypatch, enabled=True)
        chat = _FakeChat()
        _run(_state(2), chat, monkeypatch=monkeypatch)
        assert all("【参考资料】" in u for _, u in chat.seen)

    def test_disabled_rag_leaves_briefs_untouched(self, monkeypatch):
        self._patch_rag(monkeypatch, enabled=False)
        chat = _FakeChat()
        _run(_state(2), chat, monkeypatch=monkeypatch)
        assert all("【参考资料】" not in u for _, u in chat.seen)

    def test_rag_gate_exception_does_not_break_generation(self, monkeypatch):
        self._patch_rag(monkeypatch, boom=True)
        chat = _FakeChat()
        out = _run(_state(2), chat, monkeypatch=monkeypatch)
        assert len(out) == 2, "检索故障不该阻断正文生成"


class TestPgAuditTrail:
    """章节事件必须落 agent_event_log：Redis 进度流 24h 过期（2026-08-01 空转事故复盘时
    PG 里只有一条 run.start）——这条审计线删旧引擎（#85）时不能跟着丢。"""

    class _Recorder:
        def __init__(self):
            self.events: list = []

        def log_event(self, run_id, agent_type, event_type, **kw):
            self.events.append((event_type, kw.get("data")))

    def _run_with_recorder(self, state, chat, monkeypatch):
        from types import SimpleNamespace

        from agent.agents.bidding_agent.nodes import content_pipeline as mod
        from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline
        monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat)
        rec = self._Recorder()
        ctx = SimpleNamespace(thread_id="proj-t", run_id="r1", redis=None, gateway=object(),
                              recorder=rec, agent_type="bidding_agent", user_id=None)
        asyncio.run(run_content_pipeline(ctx, state))
        return rec

    def test_chapter_done_is_logged_to_pg(self, monkeypatch):
        rec = self._run_with_recorder(_state(2), _FakeChat(), monkeypatch)
        dones = [d for t, d in rec.events if t == "chapter.done"]
        assert len(dones) == 2 and dones[-1]["done"] == 2 and dones[-1]["total"] == 2

    def test_missing_chapters_are_logged_to_pg(self, monkeypatch):
        rec = self._run_with_recorder(_state(3), _FakeChat(bad_ids={"章节2"}), monkeypatch)
        inc = [d for t, d in rec.events if t == "content_incomplete"]
        assert inc and inc[0]["missing"] == ["t2"] and inc[0]["total"] == 3

    def test_pg_failure_never_breaks_generation(self, monkeypatch):
        class _Boom(self._Recorder):
            def log_event(self, *a, **kw):
                raise RuntimeError("db down")

        from types import SimpleNamespace

        from agent.agents.bidding_agent.nodes import content_pipeline as mod
        from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline
        chat = _FakeChat()
        monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat)
        ctx = SimpleNamespace(thread_id="proj-t", run_id="r1", redis=None, gateway=object(),
                              recorder=_Boom(), agent_type="bidding_agent", user_id=None)
        out = asyncio.run(run_content_pipeline(ctx, _state(2)))
        assert len(out) == 2, "埋点落库失败不得影响正文生成"


def test_all_chapters_failing_raises(monkeypatch):
    """一章都没写出来 → 整步失败（run failed 可重试退款），不能安静交付一本空书。"""
    chat = _FakeChat(bad_ids={"章节1", "章节2"})
    with pytest.raises(RuntimeError, match="未产出任何章节草稿"):
        _run(_state(2), chat, monkeypatch=monkeypatch)


def test_content_node_delegates_to_the_pipeline(monkeypatch):
    """正文节点 = 流水线 + 收尾遥测（#85 删旧引擎后唯一路径）——接线必须是真的。"""
    from agent.agents.bidding_agent.nodes import content as content_mod
    from types import SimpleNamespace

    called = {}

    async def fake_pipeline(ctx, state):
        called["ran"] = True
        return {"t1": "<p>x</p>"}

    from agent.agents.bidding_agent.nodes import content_pipeline as pmod
    monkeypatch.setattr(pmod, "run_content_pipeline", fake_pipeline)
    ctx = SimpleNamespace(thread_id="t", run_id="r", redis=None, gateway=None, recorder=None,
                          agent_type="bidding_agent", user_id=None)
    out = asyncio.run(content_mod.make_content_node(ctx)(
        {"outline": {"chapters": [{"id": "t1", "no": "一", "title": "x", "group": "tech"}]},
         "read": {}}))
    assert called.get("ran") and out == {"chapters": {"t1": "<p>x</p>"}}
