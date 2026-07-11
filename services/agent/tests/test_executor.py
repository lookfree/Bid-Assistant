import asyncio
import json
import threading
from datetime import datetime, timedelta, timezone

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime import executor as executor_mod
from agent.runtime.dispatch import create_run
from agent.runtime.executor import process_run
from agent.runtime.channels import heartbeat_key, progress_stream, result_key, runmeta_key


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
    """_publish 用到的 pipeline 四连（xadd/expire/set 心跳/execute）：全无操作。"""

    def xadd(self, *a, **kw):
        return self

    def expire(self, *a, **kw):
        return self

    def set(self, *a, **kw):
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


# ---------------------------------------------------------------------------
# spec318：心跳续期（process_run 事件发布顺带续期） + sweep_stale_runs 心跳/queued 清道夫。
# ---------------------------------------------------------------------------

class _HeartbeatTrackingRedis(_FakeRedis):
    """在 _FakeRedis 基础上真正记录 pipeline.set 写入的心跳键（键→ex 秒数），
    验证 process_run 每次发布事件都续期 run:hb:<run_id>。"""

    def __init__(self):
        self.sets: dict[str, int] = {}

    def pipeline(self):
        outer = self

        class _Pipe(_FakePipeline):
            def set(self_inner, key, value, ex=None):
                outer.sets[key] = ex
                return self_inner

        return _Pipe()


async def test_process_run_refreshes_heartbeat_on_each_publish(monkeypatch):
    """spec318：run 存活期间发布的每个事件（run.start/node.end/run.end...）都续期心跳——
    这是最省事的存活证明落点，不需要额外的定时心跳任务。"""
    fake_r = _HeartbeatTrackingRedis()
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)
    monkeypatch.setattr(executor_mod, "_rec", lambda: _MinimalRecorder())
    monkeypatch.setattr(executor_mod, "get_agent", lambda agent_type: _FakeAgent())
    monkeypatch.setattr(executor_mod.settings, "app_callback_url", None)

    await process_run("run-hb")

    assert fake_r.sets.get(heartbeat_key("run-hb")) == executor_mod.settings.run_heartbeat_ttl_s


class _FakeRecorderForSweep:
    """sweep_stale_runs 用到的两个 Recorder 方法：list_active_runs 喂固定行、finish_run 记调用。"""

    def __init__(self, rows: list[tuple]):
        self._rows = rows
        self.finish_calls: list[tuple] = []

    def list_active_runs(self):
        return self._rows

    def finish_run(self, run_id, status=None, error=None, error_type=None, node_count=None):
        self.finish_calls.append((run_id, status, error, error_type))


class _FakeRedisForSweep:
    """sweep_stale_runs 用到的 Redis 命令的最小假件：
    - exists：心跳键是否存活，按 run_id in heartbeats 判定（不模拟真实 TTL 过期机制）。
    - xpending_range + xrange：两段模拟"stream 侧还有该 run_id 对应 pending 条目"，
      每个 pending run_id 分配一个假 message_id，xrange 按 id 查回 {run_id: ...} fields。
    """

    def __init__(self, *, heartbeats: set[str] | None = None, pending_ids: set[str] | None = None):
        self._heartbeats = set(heartbeats or ())
        self._pending = {f"p-{i}": rid for i, rid in enumerate(pending_ids or ())}
        self.events: list[dict] = []

    def exists(self, key: str) -> int:
        run_id = key.rsplit(":", 1)[-1]
        return 1 if run_id in self._heartbeats else 0

    def xpending_range(self, name, group, min, max, count):
        return [{"message_id": mid} for mid in self._pending]

    def xrange(self, name, min, max):
        rid = self._pending.get(min)
        return [(min, {"run_id": rid})] if rid else []

    def pipeline(self):
        return _CapturingPipeline(self.events)


async def test_sweep_stale_runs_running_without_heartbeat_is_reaped(monkeypatch):
    """running 状态但心跳键已过期：worker 被杀、连 XAUTOCLAIM 都够不到（entry 早已 ack）= 孤儿。"""
    created = datetime.now(timezone.utc) - timedelta(seconds=5)
    rec = _FakeRecorderForSweep([("run-dead", "running", created)])
    fake_r = _FakeRedisForSweep()
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 1, "queued_reaped": 0}
    assert rec.finish_calls == [("run-dead", "failed", "worker 中断，run 孤儿回收", "HeartbeatMissing")]
    end_events = [e for e in fake_r.events if e["type"] == "run.end"]
    assert len(end_events) == 1
    assert end_events[0]["data"]["status"] == "failed"


async def test_sweep_stale_runs_running_with_live_heartbeat_untouched(monkeypatch):
    """有心跳 = 仍在正常跑，绝不误伤。"""
    created = datetime.now(timezone.utc) - timedelta(seconds=5)
    rec = _FakeRecorderForSweep([("run-alive", "running", created)])
    fake_r = _FakeRedisForSweep(heartbeats={"run-alive"})
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 0, "queued_reaped": 0}
    assert rec.finish_calls == []


async def test_sweep_stale_runs_queued_fresh_untouched(monkeypatch):
    """queued 刚创建，远没到 QUEUED_STALE_S：不该被误判成丢单。"""
    created = datetime.now(timezone.utc)
    rec = _FakeRecorderForSweep([("run-fresh", "queued", created)])
    fake_r = _FakeRedisForSweep()
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 0, "queued_reaped": 0}
    assert rec.finish_calls == []


async def test_sweep_stale_runs_queued_stale_and_not_pending_is_reaped(monkeypatch):
    """queued 超过 QUEUED_STALE_S 且 stream 侧找不到对应 pending 条目 = 消息丢失。"""
    stale_s = executor_mod.settings.queued_stale_s
    created = datetime.now(timezone.utc) - timedelta(seconds=stale_s + 1)
    rec = _FakeRecorderForSweep([("run-lost", "queued", created)])
    fake_r = _FakeRedisForSweep()
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 0, "queued_reaped": 1}
    assert rec.finish_calls == [("run-lost", "failed", "排队丢失，已回收", "QueuedStale")]


async def test_sweep_stale_runs_queued_stale_but_still_pending_untouched(monkeypatch):
    """stream 侧还有对应 pending 条目 = 仍在正常处理链路上（in-flight 或刚被投递），不是丢单。"""
    stale_s = executor_mod.settings.queued_stale_s
    created = datetime.now(timezone.utc) - timedelta(seconds=stale_s + 1)
    rec = _FakeRecorderForSweep([("run-slow", "queued", created)])
    fake_r = _FakeRedisForSweep(pending_ids={"run-slow"})
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 0, "queued_reaped": 0}
    assert rec.finish_calls == []


async def test_sweep_stale_runs_no_active_runs_short_circuits(monkeypatch):
    """没有 running/queued 的 run：连 Redis 都不该查。"""
    rec = _FakeRecorderForSweep([])
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)

    def boom():
        raise AssertionError("不该在没有 active run 时还去查 Redis")

    monkeypatch.setattr(executor_mod, "get_redis", boom)

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 0, "queued_reaped": 0}


async def test_sweep_stale_runs_list_error_is_swallowed(monkeypatch):
    """list_active_runs 抛错（PG 瞬断）：本轮跳过，不冒泡打崩 worker 消费循环。"""
    class _BoomRecorder:
        def list_active_runs(self):
            raise RuntimeError("PG 瞬断")

    monkeypatch.setattr(executor_mod, "_rec", lambda: _BoomRecorder())

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 0, "queued_reaped": 0}


async def test_sweep_stale_runs_per_row_error_does_not_block_others(monkeypatch):
    """单条处置失败（如某个 run 的心跳查询瞬断）不该拖垮同批其它条目的处置。"""
    created = datetime.now(timezone.utc) - timedelta(seconds=5)
    rec = _FakeRecorderForSweep([("run-boom", "running", created), ("run-ok", "running", created)])

    class _BoomOnceRedis(_FakeRedisForSweep):
        def exists(self, key):
            if "run-boom" in key:
                raise RuntimeError("redis 瞬断")
            return super().exists(key)

    fake_r = _BoomOnceRedis()
    monkeypatch.setattr(executor_mod, "_rec", lambda: rec)
    monkeypatch.setattr(executor_mod, "get_redis", lambda: fake_r)

    result = await executor_mod.sweep_stale_runs()

    assert result == {"running_reaped": 1, "queued_reaped": 0}
    assert [c[0] for c in rec.finish_calls] == ["run-ok"]
