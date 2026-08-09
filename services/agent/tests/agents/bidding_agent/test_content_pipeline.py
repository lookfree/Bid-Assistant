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

    def xadd(self, key, fields, maxlen=None, approximate=True):
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

    def test_system_chapters_are_structurally_skipped(self, monkeypatch):
        """系统章（如 sys-creds）结构性跳过（评审 2026-08-09 实证：App 侧 state_overrides
        每次 content 触发都会把库里 outline result 回灌，outline 带着系统章是常态而非例外）——
        流水线绝不能把它当普通章发模型调用：不进章清单、不进进度 total、不入 titles、
        也不该作为"相邻章节"字样泄漏进任何一份简报（偏离/预算判定同源于这份净化后的 outline）。"""
        state = _state(3)
        state["outline"]["chapters"].append(
            {"id": "sys-creds", "no": "附录", "title": "资格证明文件", "group": "business",
             "system": True, "sourced": False, "items": []})
        redis = _FakeRedis()
        chat = _FakeChat()
        out = _run(state, chat, redis=redis, monkeypatch=monkeypatch)
        assert "sys-creds" not in out
        assert chat.calls == 3, "系统章不该占一次模型调用"
        assert all("资格证明文件" not in u for _, u in chat.seen), "系统章标题泄漏进了某份简报"
        import json as _json
        dones = [_json.loads(f["event"])["data"] for f in redis.streams if "chapter" in str(f.get("event"))]
        assert {d["total"] for d in dones} == {3}, "进度 total 混进了系统章"

    def test_system_flag_missing_but_id_matches_sys_creds_still_skipped(self, monkeypatch):
        """纵深兜底（终审 C1）：web 侧曾在提纲保存时漏透传 "system" 键，库里 sys-creds 章会
        丢失这个标记——那种坏数据一旦流回 content，只靠 c.get("system") 判断就会把附录当
        普通章发模型改写（幻觉）。id 命中 SYS_CREDS_ID 必须独立兜底跳过，不依赖 system 键存在。"""
        state = _state(3)
        state["outline"]["chapters"].append(
            {"id": "sys-creds", "no": "附录", "title": "资格证明文件", "group": "business",
             "sourced": False, "items": []})   # 故意不带 "system" 键
        chat = _FakeChat()
        out = _run(state, chat, monkeypatch=monkeypatch)
        assert "sys-creds" not in out
        assert chat.calls == 3, "system 键丢了，附录仍被当成一次模型调用"
        assert all("资格证明文件" not in u for _, u in chat.seen), "系统章标题泄漏进了某份简报"


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


class TestTruncationGuard:
    """输出被长度上限截断（finish_reason=length）绝不当成品：不入库、不进缓存、重试一次。
    评审 2026-08-08：半章一旦进 24h 缓存,之后每次重试都零成本复读同一个半章。"""

    class _TruncChat(_FakeChat):
        def __init__(self, trunc_forever=False):
            super().__init__()
            self.trunc_forever = trunc_forever
            self.truncated_once = False

        async def ainvoke(self, msgs, config=None):
            out = await super().ainvoke(msgs, config)
            tail = msgs[-1].content.split("请撰写本章")[-1]
            if "章节1" in tail and (self.trunc_forever or not self.truncated_once):
                self.truncated_once = True
                out.response_metadata = {"finish_reason": "length"}
            return out

    def test_truncated_then_ok_recovers(self, monkeypatch):
        chat = self._TruncChat()
        out = _run(_state(2), chat, monkeypatch=monkeypatch)
        assert "t1" in out and len(out) == 2, "截断一次后重试就该救回来"

    def test_always_truncated_is_missing_and_never_cached(self, monkeypatch):
        redis = _FakeRedis()
        chat = self._TruncChat(trunc_forever=True)
        out = _run(_state(2), chat, redis=redis, monkeypatch=monkeypatch)
        assert "t1" not in out and "t2" in out
        cached = [v for v in redis.kv.values() if v]
        assert len(cached) == 1, "截断稿混进了缓存——之后每次重试都会复读半章"


def test_deviation_reaches_structure_ref_marked_chapter(monkeypatch):
    """靠 structure_ref 识别的偏离章（标题不含「偏离」）也必须拿到条目数据——
    评审 2026-08-08：造数据认两条判定、发数据只认标题,这类章拿到零条目。"""
    state = _state(2)
    state["outline"]["chapters"][0]["title"] = "响应清单"
    state["outline"]["chapters"][0]["structure_ref"] = "s2"
    state["read"] = {"required_structure": [{"id": "s2", "title": "商务偏离表"}],
                     "categories": [{"key": "commercial", "title": "商务", "items": [
                         {"title": "交付周期", "value": "90天", "star": True, "clause_ids": ["sec-3-c1"]}]}]}
    chat = _FakeChat()
    _run(state, chat, monkeypatch=monkeypatch)
    assert "偏离表指引" in _brief_of(chat, "响应清单")
    assert "偏离表指引" not in _brief_of(chat, "章节2")


def test_template_does_not_overmatch_by_title_substring(monkeypatch):
    """散文章标题恰好出现在别章模板原文里,不得错收模板——评审 2026-08-08:旧的子串匹配
    会让「服务承诺」章收到 30k 无关表单并当格式文书来写。"""
    state = _state(2)
    state["outline"]["chapters"][0].update({"title": "投标函格式", "structure_ref": "s1",
                                            "items": [{"id": "i1", "label": "投标函", "clause_ids": ["sec-8-c1"]}]})
    state["outline"]["chapters"][1]["title"] = "服务承诺"
    state["read"] = {"required_structure": [{"id": "s1", "title": "投标函", "kind": "form",
                                             "clause_ids": ["sec-8-c1"]}],
                     "doc_sections": [{"id": "sec-8-c1", "text": "致招标人：我方郑重作出服务承诺并参加投标"}]}
    chat = _FakeChat()
    _run(state, chat, monkeypatch=monkeypatch)
    assert "招标格式模板" in _brief_of(chat, "投标函格式")
    assert "招标格式模板" not in _brief_of(chat, "服务承诺"), "标题子串误配——散文章收到了表单模板"


def test_cache_survives_rag_reference_jitter(monkeypatch):
    """检索段是易变的（资料库更新/召回抖动）,**不进缓存键**——否则重试时 20 章键全变,
    "只补缺章"静默退化成全量重跑（评审 2026-08-08;旧引擎 resume 哈希刻意排除过它）。"""
    from agent.agents.bidding_agent.nodes import content as content_mod

    ref = {"v": "第一版参考资料"}

    class _Rag:
        @staticmethod
        async def rag_enabled(user_id, run_input):
            return True

        @staticmethod
        async def build_reference_block(user_id, queries, top_k, tender_thread_id=None):
            return f"【参考资料】{ref['v']}"

    monkeypatch.setattr(content_mod, "rag_retrieve", _Rag)
    redis = _FakeRedis()
    chat1 = _FakeChat()
    _run(_state(3), chat1, redis=redis, monkeypatch=monkeypatch)
    assert chat1.calls == 3
    ref["v"] = "召回抖动后的第二版"
    chat2 = _FakeChat()
    out = _run(_state(3), chat2, redis=redis, monkeypatch=monkeypatch)
    assert chat2.calls == 0, "检索段一抖缓存全失效——续跑等于没做"
    assert len(out) == 3


def test_one_chapter_bad_brief_does_not_kill_the_others(monkeypatch):
    """单章简报构造抛错只废本章：gather 里一个未捕获异常会取消全部在飞章（评审 2026-08-08）。"""
    from agent.agents.bidding_agent.nodes import content_pipeline as mod

    orig = mod._chapter_brief

    def _boom(state, ch, shared):
        if ch.get("id") == "t2":
            raise ValueError("脏提纲数据")
        return orig(state, ch, shared)

    monkeypatch.setattr(mod, "_chapter_brief", _boom)
    out = _run(_state(3), _FakeChat(), monkeypatch=monkeypatch)
    assert "t2" not in out and len(out) == 2, "一章的脏数据连累了其他章"


def test_garbage_outline_items_survive_brief_building(monkeypatch):
    """脏 items（裸字符串/自引用/数字 children）走类型钳制,照常成章——API 层对 items 零校验。"""
    state = _state(2)
    loop: dict = {"id": "x", "label": "自引用"}
    loop["children"] = [loop]
    state["outline"]["chapters"][0]["items"] = ["裸字符串", 5, loop, {"id": "a", "label": "1.1 总体", "children": 7}]
    out = _run(state, _FakeChat(), monkeypatch=monkeypatch)
    assert len(out) == 2


def test_permanent_error_fails_fast_with_root_cause(monkeypatch):
    """模型未配置/整链鉴权失败是永久性错误：整步立即失败并带出根因,
    不做逐章 2N 次无意义重试、不给一句笼统的"全部章节生成失败"（评审 2026-08-08）。"""
    from agent.models.gateway import ModelNotConfigured

    class _DeadChat(_FakeChat):
        async def ainvoke(self, msgs, config=None):
            self.calls += 1
            raise ModelNotConfigured("模型 provider 'x' 未配置 API Key——请在运营后台「模型管理」为该模型配置密钥")

    chat = _DeadChat()
    with pytest.raises(ModelNotConfigured, match="未配置 API Key"):
        _run(_state(4), chat, monkeypatch=monkeypatch)
    assert chat.calls <= 4, f"永久性错误仍被逐章重试了 {chat.calls} 次"


class TestBriefRichness:
    """删规划者时丢掉的"上下文搬运"职责必须补齐（评审 2026-08-08 批次 2）：
    深层提纲/desc/项目信息/红线/★全量要求都要到写手手里。"""

    def _rich_state(self):
        state = _state(2)
        state["outline"]["chapters"][0]["desc"] = "重点写涉密合规"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "l2", "label": "一、总体", "children": [
                {"id": "l3", "label": "1. 架构", "children": [
                    {"id": "l4", "label": "（1）人员配置", "desc": "给出值班表", "clause_ids": ["sec-9-c3"]}]}]}]
        state["read"] = {
            "project_meta": {"purchaser": "海警医院", "project_no": "HF26-0236"},
            "risk_summary": [{"title": "未按格式盖章将废标", "clause_ids": ["sec-2-c9"]}],
            "categories": [{"key": "technical", "title": "技术", "items":
                            [{"title": f"★要求{i}", "value": "必须满足", "star": True, "clause_ids": ["sec-9-c3"]}
                             for i in range(15)] +
                            [{"title": f"普通要求{i}", "value": "满足", "star": False, "clause_ids": ["sec-9-c3"]}
                             for i in range(60)]}],
        }
        state["run_input"] = {"target_chars": 100000}
        return state

    def test_deep_outline_and_desc_reach_the_writer(self, monkeypatch):
        chat = _FakeChat()
        _run(self._rich_state(), chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "章节1")
        assert "（1）人员配置" in brief, "四级子项没到写手——「拆到四级成品只有两级」复发通道"
        assert "给出值班表" in brief and "重点写涉密合规" in brief, "用户手写 desc 丢了"

    def test_all_star_requirements_survive_the_cap(self, monkeypatch):
        chat = _FakeChat()
        _run(self._rich_state(), chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "章节1")
        assert all(f"★ ★要求{i}" in brief for i in range(15)), "★ 要求被上限静默丢弃"
        assert "条普通要求未逐条列出" in brief, "普通条目截断必须如实注明"

    def test_project_meta_risk_and_budget_reach_briefs(self, monkeypatch):
        chat = _FakeChat()
        _run(self._rich_state(), chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "章节1")
        assert "海警医院" in brief, "表单章拿不到采购人,只能编或留空"
        assert "废标" in brief, "读标红线从未影响任何章"
        assert "本章目标约" in brief and "全书目标约" in brief
        import re
        assert not re.search(r"sec-\d+-c\d+", brief), "红线/要求块泄漏了内部条款 id"


def test_na_chapter_one_sentence_is_accepted(monkeypatch):
    """「（本项目不适用）」章按写手规则正文只有一句——不得被 120 字下限判残章再逼重写
    （评审 2026-08-08：模型两次合规反被记缺章,白烧两次调用）。"""

    class _NaChat(_FakeChat):
        async def ainvoke(self, msgs, config=None):
            tail = msgs[-1].content.split("请撰写本章")[-1]
            if "不适用" in tail:
                self.calls += 1
                from langchain_core.messages import AIMessage as _AI
                return _AI(content="<p>本项目不涉及涉外数据，故本项不适用。</p>")
            return await super().ainvoke(msgs, config)

    state = _state(2)
    state["outline"]["chapters"][0]["title"] = "涉外数据合规（本项目不适用）"
    chat = _NaChat()
    out = _run(state, chat, monkeypatch=monkeypatch)
    assert "t1" in out and "不适用" in out["t1"]


def test_partial_delivery_tombstones_replace_stale_generation(monkeypatch):
    """部分交付防混稿（评审 2026-08-08）：缺章写 None 墓碑,合并 reducer 覆掉上一代旧稿,
    chapters_in_outline 统一滤掉——绝不交付一本新旧提纲混杂的"完整"书。"""
    import asyncio as _aio
    from types import SimpleNamespace

    from agent.agents.bidding_agent.nodes import content as content_mod
    from agent.agents.bidding_agent.nodes import content_pipeline as pmod
    from agent.agents.bidding_agent.nodes.common import chapters_in_outline
    from agent.agents.bidding_agent.state import _merge_dict

    async def fake_pipeline(ctx, state):
        return {"t1": "<p>新一代 t1</p>"}          # t2 两次尝试都失败

    monkeypatch.setattr(pmod, "run_content_pipeline", fake_pipeline)
    ctx = SimpleNamespace(thread_id="t", run_id="r", redis=None, gateway=None, recorder=None,
                          agent_type="bidding_agent", user_id=None)
    outline = {"chapters": [{"id": "t1", "no": "一", "title": "甲", "group": "tech"},
                            {"id": "t2", "no": "二", "title": "乙", "group": "tech"}]}
    node_out = _aio.run(content_mod.make_content_node(ctx)({"outline": outline, "read": {}}))
    assert node_out["chapters"]["t2"] is None, "缺章没打墓碑"
    merged = _merge_dict({"t1": "<p>旧 t1</p>", "t2": "<p>按旧提纲写的旧 t2</p>"}, node_out["chapters"])
    assert chapters_in_outline(merged, outline) == {"t1": "<p>新一代 t1</p>"}, \
        "上一代旧稿混进了本次交付"
    assert chapters_in_outline({"t1": "x", "t2": None}, {}) == {"t1": "x"}  # 无提纲分支同样滤墓碑


class TestLibraryRefsInjection:
    """资料库人员/业绩定向注入（2026-08-09 计划 Task 3）：章标题/子项 label 命中关键词即
    确定性拼进简报——不再赌 RAG 召回率覆盖长尾（人员信息/项目业绩这类结构化条目）。"""

    def _refs(self, n_personnel=1, n_performance=1):
        return {
            "personnel": [{"title": f"人员{i}", "meta": "项目经理", "body": "十年同类项目经验",
                          "fields": [{"label": "职称", "value": "高级工程师"}]}
                         for i in range(n_personnel)],
            "performance": [{"title": f"业绩{i}", "meta": "2024 年", "body": "按期顺利交付",
                             "fields": [{"label": "合同额", "value": "500 万元"}]}
                            for i in range(n_performance)],
        }

    def _state(self):
        state = _state(3)
        state["outline"]["chapters"][0]["title"] = "项目团队与人员配置"
        state["outline"]["chapters"][1]["title"] = "公司业绩"
        state["outline"]["chapters"][2]["title"] = "技术方案"
        return state

    def test_matching_chapters_get_their_block_unrelated_chapter_gets_neither(self, monkeypatch):
        state = self._state()
        state["run_input"] = {"library_refs": self._refs()}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        personnel_brief = _brief_of(chat, "项目团队与人员配置")
        performance_brief = _brief_of(chat, "公司业绩")
        tech_brief = _brief_of(chat, "技术方案")
        assert "【资料库·人员】" in personnel_brief and "人员0" in personnel_brief
        assert "【资料库·业绩】" not in personnel_brief
        assert "【资料库·业绩】" in performance_brief and "业绩0" in performance_brief
        assert "【资料库·人员】" not in performance_brief
        assert "【资料库·人员】" not in tech_brief and "【资料库·业绩】" not in tech_brief

    def test_budget_truncation_caps_the_block_and_notes_dropped_count(self, monkeypatch):
        """30 条长条目顶穿预算——块必须截断在 `_LIBRARY_REF_BLOCK_CHARS` 内并如实注明
        未列出条数（评审：App 侧单条字段无字符上限，这是唯一防线）。"""
        from agent.agents.bidding_agent.nodes.content_pipeline import _LIBRARY_REF_BLOCK_CHARS

        state = self._state()
        long_body = "详" * 500
        state["run_input"] = {"library_refs": {
            "personnel": [{"title": f"人员{i}", "body": long_body} for i in range(30)],
            "performance": [],
        }}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "项目团队与人员配置")
        block = brief.split("【资料库·人员】")[1]
        assert "(另有" in block and "条未列出)" in block
        block_before_note = "【资料库·人员】" + block.split("(另有")[0]
        assert len(block_before_note) <= _LIBRARY_REF_BLOCK_CHARS, "预算截断没生效，30 条长条目全塞进了简报"

    def test_no_library_refs_leaves_every_brief_untouched(self, monkeypatch):
        """无 library_refs 时今天的行为逐字节不变——哪怕章标题命中关键词也不该多出任何块
        （回归硬承诺：`shared["personnel"]`/`shared["performance"]` 缺省时必须是空串）。"""
        chat = _FakeChat()
        _run(self._state(), chat, monkeypatch=monkeypatch)
        for _, user in chat.seen:
            assert "【资料库·人员】" not in user and "【资料库·业绩】" not in user

    def test_library_stock_change_invalidates_cache_only_for_the_matching_chapter(self, monkeypatch):
        """注入进 stable 部分：库存变化让命中章的缓存键跟着变（重新生成），无关章
        （标题不含人员/业绩关键词）与内容未变的章一律缓存命中，不白烧调用。"""
        redis = _FakeRedis()
        state = self._state()
        state["run_input"] = {"library_refs": self._refs()}
        chat1 = _FakeChat()
        _run(state, chat1, redis=redis, monkeypatch=monkeypatch)
        assert chat1.calls == 3

        state2 = self._state()
        state2["run_input"] = {"library_refs": self._refs(n_personnel=2)}  # 只有人员库存变了
        chat2 = _FakeChat()
        _run(state2, chat2, redis=redis, monkeypatch=monkeypatch)
        assert chat2.calls == 1, f"库存变化应只让命中章缓存失效，其余命中缓存；实际重写了 {chat2.calls} 章"
        assert any("项目团队与人员配置" in u.split("请撰写本章")[-1] for _, u in chat2.seen), \
            "库存变化的正是人员章，它却没有重写"
