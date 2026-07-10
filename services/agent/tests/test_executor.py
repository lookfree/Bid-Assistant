import asyncio
import json
import threading

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime import executor as executor_mod
from agent.runtime.dispatch import create_run
from agent.runtime.executor import process_run
from agent.runtime.channels import progress_stream, result_key, runmeta_key


def test_create_run_stores_user_id_in_meta(cleanup_run):
    """spec316 A2 契约：CreateRunBody.user_id → create_run 存进 runmeta（App 每 run 透传）。"""
    r = get_redis()
    run_id = cleanup_run(create_run("dummy", {"text": "ok"}, user_id="u-7"))
    meta = json.loads(r.get(runmeta_key(run_id)))
    assert meta["user_id"] == "u-7"


def test_create_and_process_run_end_to_end(cleanup_run):
    r = get_redis()
    run_id = cleanup_run(create_run("dummy", {"text": "ok"}))
    asyncio.run(process_run(run_id))

    # 状态 = succeeded，结果落 Redis
    with get_pool().connection() as conn:
        status = conn.execute("select status from agent.agent_request where run_id=%s", (run_id,)).fetchone()[0]
    assert status == "succeeded"
    assert json.loads(r.get(result_key(run_id)))["echo"] == "ok"

    # 进度事件落 Stream（可回放）：run 跑完后仍能从头 xrange 拿全过程——正是 pub/sub 做不到的"晚订阅"。
    evs = r.xrange(progress_stream(run_id))
    types = [json.loads(f["event"])["type"] for _id, f in evs]
    assert "run.start" in types and "chunk" in types and "run.end" in types


class _FakePipeline:
    """_publish 用到的 pipeline 三连（xadd/expire/execute）：全无操作。"""

    def xadd(self, *a, **kw):
        return self

    def expire(self, *a, **kw):
        return self

    def execute(self, *a, **kw):
        return None


class _FakeRedis:
    def get(self, key):
        return '{"agent_type": "dummy", "thread_id": "t"}'

    def set(self, *a, **kw):
        return None

    def pipeline(self):
        return _FakePipeline()


class _FakeAgent:
    async def astream(self, input, ctx):
        yield {"type": "node.end", "node": "x", "data": {"result": {}}}


class _FakeRecorder:
    """start_run 里做双向 threading.Event 握手（不是 asyncio.Event——握手发生在 to_thread
    的工作线程里）：两个 run 都置位自己的 event 再等对方，等到 = 证明 start_run 确实并发跑在
    线程池里。若 executor 没把 start_run 卸载到 asyncio.to_thread，第一个 start_run 会直接占住
    事件循环同步阻塞，另一个 run 永远轮不到、5s 后 wait 超时，assert 确定性失败。"""

    def __init__(self, events: dict[str, threading.Event]):
        self._events = events

    def start_run(self, run_id, agent_type, thread_id):
        self._events[run_id].set()
        other_id = next(k for k in self._events if k != run_id)
        assert self._events[other_id].wait(timeout=5), (
            f"{run_id} 的 start_run 没等到 {other_id} 重叠执行——同步调用卡住了事件循环"
        )

    def log_event(self, *a, **kw):
        pass

    def finish_run(self, *a, **kw):
        pass

    def usage_summary(self, run_id):
        return {}


async def test_process_run_offloads_sync_calls_so_two_runs_overlap(monkeypatch):
    """两个 process_run 用 asyncio.gather 并发跑，全 fake（不连真实基建）。
    禁止墙钟计时断言——重叠性只靠 start_run 里的握手证明。"""
    events = {"run-a": threading.Event(), "run-b": threading.Event()}
    recorder = _FakeRecorder(events)

    monkeypatch.setattr(executor_mod, "get_redis", lambda: _FakeRedis())
    monkeypatch.setattr(executor_mod, "_rec", lambda: recorder)
    monkeypatch.setattr(executor_mod, "get_agent", lambda agent_type: _FakeAgent())
    monkeypatch.setattr(executor_mod.settings, "app_callback_url", None)

    await asyncio.gather(process_run("run-a"), process_run("run-b"))


class _FakeRecorderForReap:
    """只实现 reap_orphan_run 用到的两个方法：run_status 查状态、finish_run 记调用参数。"""

    def __init__(self, status: str | None):
        self._status = status
        self.finish_calls: list[tuple] = []

    def run_status(self, run_id):
        return self._status

    def finish_run(self, run_id, status=None, error=None, error_type=None):
        self.finish_calls.append((run_id, status, error, error_type))


class _CapturingPipeline(_FakePipeline):
    """在 _FakePipeline 之上把 xadd 落的事件记下来，供断言 run.end 的内容。"""

    def __init__(self, sink: list):
        self._sink = sink

    def xadd(self, key, fields):
        self._sink.append(json.loads(fields["event"]))
        return self


class _RecorderRaisingUsage:
    """finish_run 记录终态；usage_summary 模拟瞬断 PG 错误，验证不会污染已成功落定的终态。"""

    def __init__(self):
        self.finish_calls: list[tuple] = []

    def start_run(self, run_id, agent_type, thread_id):
        pass

    def log_event(self, *a, **kw):
        pass

    def finish_run(self, run_id, status=None, **kw):
        self.finish_calls.append((run_id, status))

    def usage_summary(self, run_id):
        raise RuntimeError("PG 瞬断")


async def test_callback_usage_summary_error_does_not_flip_succeeded_run(monkeypatch):
    """_callback 里 usage_summary 抛错必须被吞掉——不能让 process_run 已经写定的 succeeded
    终态被覆写成 failed，也不能因此多发一次 run.end failed 事件（回归 spec317 review 发现的
    "usage 读失败污染已成功 run" 问题：修复前 usage_summary 抛到 _callback 外、冒进
    process_run 的 except，把成功 run 标记成失败并二次发布 run.end）。"""
    rec = _RecorderRaisingUsage()
    events: list[dict] = []
    fake_r = _FakeRedis()
    fake_r.pipeline = lambda: _CapturingPipeline(events)

    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)
    monkeypatch.setattr(executor_mod, "get_agent", lambda agent_type: _FakeAgent())
    monkeypatch.setattr(executor_mod.settings, "app_callback_url", "http://example.invalid/callback")

    await process_run("run-usage-error")

    assert rec.finish_calls == [("run-usage-error", "succeeded")]
    end_events = [e for e in events if e["type"] == "run.end"]
    assert len(end_events) == 1
    assert end_events[0]["data"]["status"] == "succeeded"


class _MinimalRecorder:
    """只实现 process_run 用到的四个方法，全无操作——只为验证 ctx 构造，不关心记账细节。"""

    def start_run(self, *a, **kw):
        pass

    def log_event(self, *a, **kw):
        pass

    def finish_run(self, *a, **kw):
        pass

    def usage_summary(self, run_id):
        return {}


class _CapturingAgent:
    def __init__(self):
        self.ctx = None

    async def astream(self, input, ctx):
        self.ctx = ctx
        yield {"type": "node.end", "node": "x", "data": {"result": {}}}


async def test_process_run_threads_user_id_into_run_context(monkeypatch):
    """spec316 A2 契约：runmeta.user_id → RunContext.user_id（RAG 节点据此判定是否生效）。"""
    fake_r = _FakeRedis()
    fake_r.get = lambda key: '{"agent_type": "dummy", "thread_id": "t", "user_id": "u-42"}'
    agent = _CapturingAgent()
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)
    monkeypatch.setattr(executor_mod, "_rec", lambda: _MinimalRecorder())
    monkeypatch.setattr(executor_mod, "get_agent", lambda agent_type: agent)
    monkeypatch.setattr(executor_mod.settings, "app_callback_url", None)

    await process_run("run-user-id")

    assert agent.ctx.user_id == "u-42"


async def test_reap_orphan_run_terminal_only_reports_no_finish_call(monkeypatch):
    """终态(succeeded/failed) run 被认领到 = 上次跑完只是没确认掉 xack；清道夫只报"terminal"，
    不调 finish_run（状态已经是终态，不需要也不该覆写）。"""
    rec = _FakeRecorderForReap("succeeded")
    monkeypatch.setattr(executor_mod, "get_redis", lambda: _FakeRedis())
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)

    disposition = await executor_mod.reap_orphan_run("run-terminal")

    assert disposition == "terminal"
    assert rec.finish_calls == []


async def test_reap_orphan_run_missing_record_reports_missing(monkeypatch):
    """查无记录（远古脏消息）：不调 finish_run，只报"missing"。"""
    rec = _FakeRecorderForReap(None)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: _FakeRedis())
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)

    disposition = await executor_mod.reap_orphan_run("run-missing")

    assert disposition == "missing"
    assert rec.finish_calls == []


async def test_reap_orphan_run_nonterminal_marks_failed_and_publishes_run_end(monkeypatch):
    """非终态(queued/running) = 孤儿（in-flight 过滤已保证属主进程已死）：标失败 + 推 run.end 失败事件。"""
    rec = _FakeRecorderForReap("running")
    events: list[dict] = []
    fake_r = _FakeRedis()
    fake_r.pipeline = lambda: _CapturingPipeline(events)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)

    disposition = await executor_mod.reap_orphan_run("run-orphan")

    assert disposition == "orphaned"
    assert rec.finish_calls == [
        ("run-orphan", "failed", "orphaned: worker exited mid-run", "Orphaned")
    ]
    assert len(events) == 1
    assert events[0]["type"] == "run.end"
    assert events[0]["data"]["status"] == "failed"
