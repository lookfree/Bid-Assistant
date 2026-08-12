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
    # 缺章补写轮的真实等待是 90 秒（评审 2026-08-09）；测试默认打成 0，个别要断言等待行为
    # 本身的测试可以在调用 _run 前再 monkeypatch 回真值或自定义桩。
    monkeypatch.setattr(mod, "_MISSING_RETRY_DELAY_S", 0)
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
        旧引擎是一处失败全盘皆输。缺章补写轮也救不回来的（bad_ids 是永久性坏）
        依然如实记缺章，不会因为多补了一次就变成假装成功。"""
        chat = _FakeChat(bad_ids={"章节3"})
        out = _run(_state(5), chat, monkeypatch=monkeypatch)
        assert "t3" not in out and len(out) == 4

    def test_missing_chapter_recovers_in_the_makeup_pass(self, monkeypatch):
        """主 gather 收尾仍缺章 → 等一下再各补一次——短暂故障不再直接变墓碑，
        这是老引擎"漏了就补"的语义回归（#85 删旧规划者引擎时随它一起丢了）。"""
        class _RecoveringChat:
            """章节3 头两次调用（主 gather 内 _write_one 的两次尝试）吐残稿，
            第三次（补写轮）恢复正常——模拟限流/连接抖动这类短暂故障。"""

            def __init__(self):
                self.calls_by_chapter: dict[str, int] = {}

            async def ainvoke(self, msgs, config=None):
                user = msgs[-1].content
                tail = user.split("请撰写本章")[-1]
                title = next((t for t in ("章节1", "章节2", "章节3") if t in tail), "")
                n = self.calls_by_chapter.get(title, 0) + 1
                self.calls_by_chapter[title] = n
                if title == "章节3" and n <= 2:
                    return AIMessage(content="太短")
                return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")

        chat = _RecoveringChat()
        out = _run(_state(3), chat, monkeypatch=monkeypatch)
        assert set(out) == {"t1", "t2", "t3"}, "短暂故障的缺章该在补写轮里补上，不该直接变墓碑"
        assert chat.calls_by_chapter["章节3"] == 3

    def test_makeup_pass_keeps_publishing_heartbeats_while_it_runs(self, monkeypatch):
        """主 gather 的 finally 在补写轮开始前就取消了心跳（评审 2026-08-09）：90s 等待 +
        补写调用期间如果不重开一个心跳任务，前端进度会静默，看起来像卡死。打桩验证：
        补写轮自己起的心跳任务在这段时间里仍周期性调用 publish_event。

        直接调 `_retry_missing`（不经完整 run_content_pipeline）：这样测出的心跳事件只可能
        来自补写轮自己开的心跳任务，不会与主 gather 的心跳（cancel 之前）混在一起，
        修复前这里必然是零事件——不修复就没有任何来源能产生心跳。"""
        from agent.agents.bidding_agent.nodes import content_pipeline as mod

        real_sleep = mod.asyncio.sleep

        async def _fake_sleep(s):
            # 只真正让出控制权（不真等），道理同 test_makeup_pass_waits_before_retrying：
            # 心跳协程内部也是 `while True: await asyncio.sleep(...)`，桩必须让它有机会转起来。
            await real_sleep(0)

        monkeypatch.setattr(mod.asyncio, "sleep", _fake_sleep)

        published: list[dict] = []

        async def _fake_publish(redis, run_id, data):
            published.append(data)

        monkeypatch.setattr(mod, "publish_event", _fake_publish)

        state = _state(2)
        chapters = state["outline"]["chapters"]
        titles = {c["id"]: c["title"] for c in chapters}
        ctx = _ctx()
        progress = mod._Progress(ctx, len(chapters), titles)
        chat = _FakeChat()

        result = asyncio.run(mod._retry_missing(
            ctx, chat, "system", state, chapters, {}, asyncio.Semaphore(2),
            progress, 0, {}, [c["id"] for c in chapters]))

        heartbeats = [d for d in published if d.get("kind") == "heartbeat"]
        assert heartbeats, "补写轮期间一条心跳事件都没发——前端进度会静默"
        assert set(result) == {c["id"] for c in chapters}

    def test_makeup_pass_waits_before_retrying(self, monkeypatch):
        """补写轮必须先等一下（给短暂故障机会自愈），不是立刻重打。

        桩必须实打实让出事件循环（`await real_sleep(0)`），不能是"await 一个不含任何
        await 的协程"——那种桩不会真正让出控制权，心跳协程里的 `while True: await
        asyncio.sleep(...)` 会因此变成不出让控制权的死循环，整个测试挂死。
        """
        from agent.agents.bidding_agent.nodes import content_pipeline as mod

        slept = []
        real_sleep = mod.asyncio.sleep

        async def _fake_sleep(s):
            slept.append(s)
            await real_sleep(0)

        monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: _FakeChat(bad_ids={"章节2"}))
        monkeypatch.setattr(mod.asyncio, "sleep", _fake_sleep)
        asyncio.run(run_content_pipeline(_ctx(), _state(3)))
        assert mod._MISSING_RETRY_DELAY_S in slept

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

    def test_a_form_chapter_gets_the_template_even_if_nobody_listed_its_name(self, monkeypatch):
        """表单章的识别不能靠穷举词表。「报价函」曾不在表里（表里只有响应函/投标函/承诺函/
        报价表），于是整章拿不到招标格式原文，模型只能自己编——用户实测:招标 7 条固定条款
        被写成 6 条全新措辞，抬头、开场白、落款全变（2026-08-11 潍坊那单）。
        这里刻意**不给 structure_ref**，只靠标题走构词法判定。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第一章 报价函（商务标）"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "i1", "label": "一、报价函", "clause_ids": ["sec-8-c1"]}]
        state["read"] = {"doc_sections": [
            {"id": "sec-8-c1", "text": "潍坊环境工程职业学院：\n1、根据已收到的项目编号____的采购项目"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第一章 报价函（商务标）")
        assert "招标格式模板" in brief, "报价函章没拿到招标格式原文"
        assert "潍坊环境工程职业学院：" in brief, "模板原文没进简报"

    def test_coarse_section_never_ships_the_notice_as_a_template(self, monkeypatch):
        """2026-08-12 云上江西的事故本体：.doc 里表单名没做成标题样式，整份采购公告挤在
        一个 sec、全部表单挤在另一个 sec；章 items 的 clause_ids 是**需求条款引用**，
        指向公告那个 sec——「整节取」就把整份公告当成响应函模板逐字下发，再被保真机制
        钉死，交付的每个表单章都是公告转储。修后：整节文本要过单份闸，只有切得出
        「本章那一份」才算命中，公告一个字都不许进表单章的简报。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第一章 响应函（技术标）"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "i1", "label": "响应承诺", "clause_ids": ["sec-1-c1", "sec-1-c2"]}]
        state["read"] = {"doc_sections": [
            # sec-1 = 公告 + 格式章引导，「1.响应函」挂在节尾（切分器把它留在上一节）
            {"id": "sec-1-c1", "text": "采购方案"},
            {"id": "sec-1-c2", "text": "（三）本项目设置最高限价，最高限价为含税人民币230000元。"},
            {"id": "sec-1-c3", "text": "1.响应函"},
            # sec-2 = 响应函正文 + 下一份表单
            {"id": "sec-2-c1", "text": "致：【XX公司[采购人名称]】："},
            {"id": "sec-2-c2", "text": "我方将严格按照询比文件要求提交符合要求的全部响应文件。"},
            {"id": "sec-2-c3", "text": "2.法定代表人授权书"},
            {"id": "sec-2-c4", "text": "（供应商全称）法定代表人授权（全权代表姓名）为全权代表。"},
        ], "doc_headings": [{"sec": "sec-2", "level": 2, "title": "响   应   函"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第一章 响应函（技术标）")
        assert "致：【XX公司[采购人名称]】：" in brief, "没按边界切出响应函那一份"
        assert "采购方案" not in brief, "整份公告被当成模板下发——事故复现"
        assert "最高限价" not in brief
        # 盯下一份表单的**正文**：表单名会出现在 TEMPLATE_GUIDE 的示例文字里，盯名字必误报
        assert "（供应商全称）法定代表人授权（全权代表姓名）" not in brief, "下一份表单混进了响应函的模板"

    def test_template_falls_back_to_matching_by_heading_when_clause_ids_miss(self, monkeypatch):
        """降级一:条款 id 定位不到就按**标题**找。条款编号靠读标切分,切歪整章就零模板——
        而招标与投标两侧对同一份表单的叫法通常一致(都叫「报价函」),标题比编号稳。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第一章 报价函"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "报价函"}]  # 无 clause_ids
        state["read"] = {
            "doc_headings": [{"sec": "sec-8", "title": "附件一 报价函", "level": 2}],
            "doc_sections": [{"id": "sec-8-c1", "text": "致：潍坊环境工程职业学院\n1、我方同意本报价函自开标之日起有效"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第一章 报价函")
        assert "我方同意本报价函自开标之日起有效" in brief, "条款 id 落空后没按标题兜到模板"
        assert "招标格式模板" not in _brief_of(chat, "章节2"), "兜底把模板漏给了无关章"

    def test_template_falls_back_to_the_whole_format_chapter(self, monkeypatch):
        """降级二:条款 id 和标题都定位不到,就把招标的「格式」章整章给它。
        **宁可多给几千字让模型自己挑,也不能一个字不给**——给零它只会自创一份格式。"""
        state = _state(2)
        # 名字在招标标题里找不到（招标叫「格式二 开标一览表」，投标这章叫「投标承诺书」），
        # 前两条路都落空 → 必须走整章兜底
        state["outline"]["chapters"][0]["title"] = "投标承诺书"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "承诺事项"}]
        # 切分器每遇一个标题就另起一个 sec：章标题那个 sec 里**只有一句导语**，
        # 真正的表单在下级标题的 sec 里。只取命中的 sec 等于兜了个空（评审 2026-08-12 实证）。
        state["read"] = {
            "doc_headings": [
                {"sec": "sec-9", "title": "第四章 响应文件相关格式", "level": 1},
                {"sec": "sec-10", "title": "格式一 报价函", "level": 2},
                {"sec": "sec-11", "title": "格式二 开标一览表", "level": 2},
                {"sec": "sec-12", "title": "第五章 技术规范书", "level": 1},   # 同级 → 格式章到此为止
                {"sec": "sec-13", "title": "5.1 性能指标", "level": 2},
            ],
            "doc_sections": [
                {"id": "sec-9-c1", "text": "投标人应按下列格式编制响应文件。"},
                {"id": "sec-10-c1", "text": "致：招标人（报价函正文）"},
                {"id": "sec-11-c1", "text": "开标一览表（此处为招标规定表样）"},
                {"id": "sec-12-c1", "text": "本章为技术规范，与格式无关"},
                {"id": "sec-13-c1", "text": "吞吐量不低于 10Gbps"},
            ]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "投标承诺书")
        assert "此处为招标规定表样" in brief, "格式章整章兜底没生效——该章拿到了零模板"
        assert "报价函正文" in brief, "只捞到章导语,漏了下级标题里的模板本体"
        assert "吞吐量不低于 10Gbps" not in brief, "越过同级标题，把技术规范章也卷进来了"

    def test_a_form_chapter_with_no_template_anywhere_is_told_to_flag_it(self, monkeypatch):
        """三条路都空时**留痕**:让模型显式提示「未找到规定格式」。
        不声不响自创一份最危险——用户以为是照招标格式写的,评标时才发现对不上。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "法人授权委托书", "structure_ref": "s1"})
        state["read"] = {"required_structure": [{"id": "s1", "title": "法人授权委托书", "kind": "form"}],
                         "doc_sections": [{"id": "sec-8-c1", "text": "与格式无关的技术要求正文"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "法人授权委托书")
        assert "未能找到" in brief and "人工比对" in brief, "无模板时没留痕,模型会静默自创格式"
        assert "招标格式模板" not in brief, (
            "留痕不许带 TEMPLATE_GUIDE：那段开头说「以下为招标自带的格式模板原文」,"
            "后面却跟着「没找到原文」,十几行「务必照抄」配一份不存在的模板=请模型编一份")

    def test_a_guessed_form_chapter_with_no_template_stays_silent(self, monkeypatch):
        """构词法只是**猜**。猜错时那句「未找到本表单的规定格式」会原样印进交付的 docx,
        出现在一个根本不是表单的章开头（评审 2026-08-12）。只有读标登记成 form 才留痕。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "服务承诺书"   # 构词法命中,但读标没登记
        state["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": "与格式无关的技术要求正文"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "未能找到" not in _brief_of(chat, "服务承诺书")

    def test_deviation_and_volume_chapters_are_not_forms(self, monkeypatch):
        """只看后缀「表」「书」会把偏离表/标书判成表单:偏离表会同时收到偏离表指引与格式模板
        两份互相打架的指令,技术标书则会收到整章无关的格式原文（评审 2026-08-12 实证）。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "技术偏离表"
        state["outline"]["chapters"][1]["title"] = "技术标书"
        state["read"] = {
            "doc_headings": [{"sec": "sec-9", "title": "第四章 响应文件相关格式", "level": 1}],
            "doc_sections": [{"id": "sec-9-c1", "text": "投标人应按下列格式编制响应文件。"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "招标格式模板" not in _brief_of(chat, "技术偏离表")
        assert "招标格式模板" not in _brief_of(chat, "技术标书")

    def test_a_form_chapter_with_a_trailing_tail_still_counts(self, monkeypatch):
        """表单章常带尾巴:「投标函及投标函附录」只看结尾会漏判——旧的子串匹配本来是中的,
        这是改构词法时引入的回归（评审 2026-08-12 实证）。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "投标函及投标函附录"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "投标函", "clause_ids": ["sec-8-c1"]}]
        state["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": "致：招标人，我方决定参加投标"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "我方决定参加投标" in _brief_of(chat, "投标函及投标函附录")

    def test_a_two_character_form_name_is_not_used_to_search_headings(self, monkeypatch):
        """按标题检索要设最短名。「证明」两个字会把「资质证明材料」「业绩证明」全捞进来，
        几千字无关原文顶着「本章的招标格式原文」发出去，模型照单全抄（评审 2026-08-12）。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第三章 证明"
        state["read"] = {
            "doc_headings": [{"sec": "sec-9", "title": "资质证明材料", "level": 2},
                             {"sec": "sec-10", "title": "业绩证明", "level": 2}],
            "doc_sections": [{"id": "sec-9-c1", "text": "投标人须提供近三年审计报告等资质材料"},
                             {"id": "sec-10-c1", "text": "近三年同类项目业绩清单及合同复印件"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第三章 证明")
        assert "近三年审计报告" not in brief and "合同复印件" not in brief

    def test_a_prose_chapter_is_not_mistaken_for_a_form(self, monkeypatch):
        """构词法不能宽到把正文章也当表单——那会把无关的招标原文塞进技术方案章。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "技术方案"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "i1", "label": "总体设计", "clause_ids": ["sec-8-c1"]}]
        state["outline"]["chapters"][1]["title"] = "服务承诺"   # 以「承诺」收尾但是散文章
        state["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": "致：（招标人名称）"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "招标格式模板" not in _brief_of(chat, "技术方案")
        assert "招标格式模板" not in _brief_of(chat, "服务承诺")


class TestFormFidelity:
    """表单章保真接线：模型改写模板 → 弃用产出、拿招标原文渲染（判定逻辑本身见
    test_form_fidelity.py，这里只管**有没有真接上流水线**）。"""

    _TPL = ("报价函\n致：潍坊环境工程职业学院\n"
            "1、我方同意本报价函自开标之日起 90 天内有效，并承诺不作任何保留。\n"
            "2、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。")

    def _state(self):
        st = _state(2)
        st["outline"]["chapters"][0]["title"] = "报价函"
        st["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "报价函", "clause_ids": ["sec-8-c1"]}]
        st["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": self._TPL}]}
        return st

    def test_a_rewritten_form_is_replaced_by_the_tender_original(self, monkeypatch):
        """用户实测的原病：招标固定条款被换成全新措辞。提示词拦不住，代码必须拦住。"""
        class _Rewriter(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                if "报价函" in msgs[-1].content.split("请撰写本章")[-1]:
                    return AIMessage(content="<h3>报价函</h3><p>本报价函有效期为九十日，"
                                             + "我方保留最终解释权。" * 20 + "</p>")
                return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")

        chat = _Rewriter()
        out = _run(self._state(), chat, monkeypatch=monkeypatch)
        html = out["t1"]
        assert "保留最终解释权" not in html, "改写稿被原样交付了——保真校验没接上"
        assert "自开标之日起 90 天内有效" in html, "退路没拿招标原文渲染"

    def test_a_faithful_fill_is_kept(self, monkeypatch):
        """只填空、没改原文的产出必须原样留下——否则等于把模型的活白干了。"""
        class _Filler(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                if "报价函" in msgs[-1].content.split("请撰写本章")[-1]:
                    return AIMessage(content=(
                        "<h3>报价函</h3><p>致：潍坊环境工程职业学院</p>"
                        "<p>1、我方同意本报价函自开标之日起 90 天内有效，并承诺不作任何保留。</p>"
                        "<p>2、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</p>"
                        "<p>投标人：上海安几科技有限公司（盖章）</p>" + "<p>补充说明。</p>" * 20))
                return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")

        chat = _Filler()
        out = _run(self._state(), chat, monkeypatch=monkeypatch)
        assert "上海安几科技有限公司" in out["t1"]

    def test_the_whole_format_chapter_fallback_does_not_police_a_single_form(self, monkeypatch):
        """降级二给的是整份格式章（报价函+授权书+声明函…），而模型**正确的做法是只写其中一份**。
        拿整章去逐字校验，单份表单必然判不过 → 每个表单章都被换成整份格式章的转储，
        同一份格式章在标书里重复 N 遍、一个填好的表单都没有（2026-08-12 评审实证）。"""
        st = _state(2)
        st["outline"]["chapters"][0]["title"] = "投标承诺书"      # 名字在招标标题里找不到 → 走降级二
        st["read"] = {
            "doc_headings": [{"sec": "sec-9", "title": "第四章 响应文件相关格式", "level": 1},
                             {"sec": "sec-10", "title": "格式一 报价函", "level": 2}],
            "doc_sections": [{"id": "sec-9-c1", "text": "投标人应按下列格式编制响应文件。"},
                             {"id": "sec-10-c1", "text": "致：招标人，我方决定参加本项目的投标，并承诺遵守全部要求。"}]}

        class _OneForm(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                if "投标承诺书" in msgs[-1].content.split("请撰写本章")[-1]:
                    return AIMessage(content="<h3>投标承诺书</h3><p>我方郑重承诺遵守招标文件全部要求。</p>"
                                             + "<p>补充承诺条款。</p>" * 20)
                return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")

        out = _run(st, _OneForm(), monkeypatch=monkeypatch)
        assert "我方郑重承诺遵守招标文件全部要求" in out["t1"], "只写一份表单的正确产出被整章比对判死了"
        assert "投标人应按下列格式编制响应文件" not in out["t1"], "整份格式章被当成本章内容转储了"

    def test_the_fallback_never_ships_the_truncation_marker(self, monkeypatch):
        """raw 只用于校验与零模型渲染，带上「…（超长截断）」会把这个内部标记原样印进交付的
        docx（本仓已为同类泄漏返工过一次，任务 #96）。"""
        long_form = "报价函\n" + "\n".join(f"{i}、我方承诺遵守招标文件的第{i}项全部要求。" for i in range(1, 400))
        st = self._state()
        st["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": long_form}]}

        class _Rewriter(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                return AIMessage(content="<h3>报价函</h3>" + "<p>我方另起炉灶写了一份。</p>" * 30)

        out = _run(st, _Rewriter(), monkeypatch=monkeypatch)
        assert "超长截断" not in out["t1"], "内部截断标记被印进交付内容"
        assert "我方承诺遵守招标文件的第399项全部要求" in out["t1"], "退路用的是被截断的模板"

    def test_bidder_info_reaches_only_the_form_chapter(self, monkeypatch):
        """单位名称/信用代码/法定代表人是**表单空位**要填的东西。散文章用不上，
        发过去只是白占本来就紧的单章预算。"""
        st = self._state()
        st["run_input"] = {"library_refs": {"company": [
            {"title": "企业信息", "fields": [{"label": "单位名称", "value": "上海安几科技有限公司"}]}]}}
        chat = _FakeChat()
        _run(st, chat, monkeypatch=monkeypatch)
        assert "上海安几科技有限公司" in _brief_of(chat, "报价函"), "表单章没拿到投标人信息"
        assert "上海安几科技有限公司" not in _brief_of(chat, "章节2"), "投标人信息发给了散文章"

    def test_no_company_entry_leaves_the_brief_untouched(self, monkeypatch):
        """没录企业信息的用户，简报里不该凭空多出一个空段落。"""
        chat = _FakeChat()
        _run(self._state(), chat, monkeypatch=monkeypatch)
        assert "【投标人信息】" not in _brief_of(chat, "报价函")

    def test_a_form_chapter_is_never_padded_to_hit_the_word_budget(self, monkeypatch):
        """给报价函注水凑字数本身就是改格式；扩写还是整章替换，一扩必然改写模板原文，
        等于自己把保真校验逼到必然退回空表。"""
        from agent.agents.bidding_agent.nodes import content_pipeline as cp

        expanded: list[str] = []

        async def _record(ctx, chat, sp, ch, user, html, budget, sem, progress):
            expanded.append(ch.get("id") or "")
            return html

        monkeypatch.setattr(cp, "_expand_short", _record)
        st = self._state()
        st["run_input"] = {"target_chars": 60000}      # 逼出很大的篇幅预算
        _run(st, _FakeChat(), monkeypatch=monkeypatch)
        assert "t1" not in expanded, "表单章被拿去扩写了"
        assert "t2" in expanded, "普通章的扩写被顺手关掉了——这条守的是「只豁免表单章」"


class TestPackageScope:
    """选包时每章简报追加范围约束（spec324，与 outline 同款）——#85 删旧规划者引擎时随它
    一起丢了，正文不再知道只投一个包件（从 test_content_node 的
    test_content_node_with_package_injects_scope_constraint 移植到流水线版）。"""

    def test_package_scope_line_reaches_every_chapter_brief(self, monkeypatch):
        state = _state(2)
        state["run_input"] = {"package": {"id": "p1", "name": "实网攻防"}}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        for title in ("章节1", "章节2"):
            brief = _brief_of(chat, title)
            assert "本项目仅投包件《实网攻防》(p1)" in brief
            assert "涉及分包件评分表/偏离表仅取该包件" in brief
            assert brief.endswith("该包件。")

    def test_no_package_selected_brief_unchanged(self, monkeypatch):
        """未选包（缺省）行为不变——不追加范围约束行。"""
        chat = _FakeChat()
        _run(_state(1), chat, monkeypatch=monkeypatch)
        assert "仅投包件" not in _brief_of(chat, "章节1")


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
        monkeypatch.setattr(mod, "_MISSING_RETRY_DELAY_S", 0)
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

    def test_tags_are_injected_into_the_block(self, monkeypatch):
        """tags（2026-08-09 结构化录入 Task 2）：条目录入提示曾录了也从不下发,用户写了白写——
        现在随 title/meta/fields/body 一起进简报行。"""
        state = self._state()
        refs = self._refs()
        refs["personnel"][0]["tags"] = ["PMP", "高级工程师"]
        state["run_input"] = {"library_refs": refs}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        personnel_brief = _brief_of(chat, "项目团队与人员配置")
        assert "标签:PMP,高级工程师" in personnel_brief

    def test_library_ref_line_format_includes_tags_between_meta_and_fields(self):
        """`_library_ref_line` 逐字段核对：title|meta|标签:tags(逗号连)|fields|body。"""
        from agent.agents.bidding_agent.nodes.content_pipeline import _library_ref_line

        line = _library_ref_line({
            "title": "张三", "meta": "项目经理", "tags": ["PMP", "高级工程师"],
            "fields": [{"label": "职称", "value": "高工"}], "body": "十年经验",
        })
        assert line == "- 张三|项目经理|标签:PMP,高级工程师|职称:高工|十年经验"

    def test_library_ref_line_tags_absent_or_empty_renders_as_empty_segment(self):
        """无 tags 键 / 空数组：该段落为空字符串，不炸、不占位错乱。"""
        from agent.agents.bidding_agent.nodes.content_pipeline import _library_ref_line

        assert _library_ref_line({"title": "李四"}) == "- 李四||||"
        assert _library_ref_line({"title": "王五", "tags": []}) == "- 王五||||"

    def test_bare_peizhi_keyword_no_longer_triggers_personnel_block(self, monkeypatch):
        """终审 I-3：人员词表删掉裸词"配置"——"人员配置"仍被"人员"覆盖照常命中，但纯技术性的
        "设备配置"/"系统配置"章不该被误抓进人员简报块（用户口径已定，计划已改）。"""
        state = self._state()
        state["outline"]["chapters"][2]["title"] = "设备配置与系统集成方案"
        state["run_input"] = {"library_refs": self._refs()}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        equip_brief = _brief_of(chat, "设备配置与系统集成方案")
        assert "【资料库·人员】" not in equip_brief

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

    def test_single_entry_alone_exceeds_budget_still_gets_capped_and_noted(self):
        """边界：**第一条自己**（非多条累计）就顶穿预算——循环首轮直接 break、dropped=全部条目。
        这条路径与上一条"多条累计超限"是截断算法里两个不同的分支，重构时最容易悄悄回归。"""
        from agent.agents.bidding_agent.nodes.content_pipeline import (
            _LIBRARY_REF_BLOCK_CHARS, _library_ref_block)

        block = _library_ref_block([{"title": "X", "body": "详" * 6000}], "人员")
        block_before_note = block.split("\n(另有")[0]
        assert len(block_before_note) <= _LIBRARY_REF_BLOCK_CHARS, "单条自身超预算却没被截断"
        assert "(另有 1 条未列出)" in block, "唯一那条被砍掉却没如实注明"

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
