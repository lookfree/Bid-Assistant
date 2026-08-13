"""content 流水线测试共享件（拆自 test_content_pipeline.py，2026-08-13 按 800 行文件规范分家）。
假 Redis/假模型/最小 state/一轮直跑，两个测试文件共用——各自复制一份会在契约变化时静默漂移。"""
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
