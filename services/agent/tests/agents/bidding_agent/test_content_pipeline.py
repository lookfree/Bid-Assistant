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
    """假模型：记录并发峰值；按章标题回不同正文；可指定某章持续吐残稿。"""

    def __init__(self, bad_ids=(), delay=0.02):
        self.bad_ids = set(bad_ids)
        self.delay = delay
        self.calls = 0
        self.now = 0
        self.peak = 0

    async def ainvoke(self, msgs, config=None):
        self.calls += 1
        self.now += 1
        self.peak = max(self.peak, self.now)
        await asyncio.sleep(self.delay)
        self.now -= 1
        user = msgs[-1].content
        tail = user.split("请撰写本章")[-1]   # 只看点名行：相邻章列表里也会出现别章标题
        bad = next((b for b in self.bad_ids if b in tail), None)
        if bad:
            return AIMessage(content="太短")
        return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")


def _ctx(redis=None):
    from types import SimpleNamespace
    return SimpleNamespace(thread_id="proj-t", run_id="r1", redis=redis, gateway=object(), recorder=None)


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


def test_default_engine_is_pipeline(monkeypatch):
    """默认引擎必须是代码编排——退回 deepagent 等于把一下午的事故根因再默认打开。"""
    from agent.config import Settings

    assert Settings(database_url="postgresql://x/x").model_content_engine == "pipeline"


def test_node_routes_by_the_engine_flag(monkeypatch):
    """开关必须真的接线：flag=pipeline 走新引擎，flag=deepagent 走旧引擎。"""
    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
    from agent.agents.bidding_agent.nodes import content as content_mod
    from types import SimpleNamespace

    called = {}

    async def fake_pipeline(ctx, state):
        called["engine"] = "pipeline"
        return {"t1": "<p>x</p>"}

    from agent.agents.bidding_agent.nodes import content_pipeline as pmod
    monkeypatch.setattr(pmod, "run_content_pipeline", fake_pipeline)
    monkeypatch.setattr(settings, "model_content_engine", "pipeline")
    ctx = SimpleNamespace(thread_id="t", run_id="r", redis=None, gateway=None, recorder=None,
                          agent_type="bidding_agent", checkpointer=None, user_id=None)
    out = asyncio.run(content_mod.make_content_node(ctx)(
        {"outline": {"chapters": [{"id": "t1", "no": "一", "title": "x", "group": "tech"}]},
         "read": {}}))
    assert called.get("engine") == "pipeline" and out == {"chapters": {"t1": "<p>x</p>"}}
