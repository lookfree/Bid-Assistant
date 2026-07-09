"""main_worker consumer group 消费的单测：不连真 Redis，最小 fake + monkeypatch。

背景：旧实现 XREAD last_id="$" 只读订阅后的新消息，worker 重启窗口内入队的 run 永远不被消费
（生产实测积压 12 条，页面永久 running）。改 consumer group 后：游标持久、处理完 XACK、
XAUTOCLAIM 认领死消费者 pending。

spec317 起两处语义变了：① 消费循环从"读一条→等跑完→读下一条"改成信号量限流的并发派发
（同时最多 agent_worker_concurrency 个 run 在跑）；② 认领路径（XAUTOCLAIM）从"重试执行"
改为孤儿清理（清道夫）——过滤掉本进程 in-flight 的 entry 后，剩下的必是孤儿，只标失败/ack，
永不重新调用 process_run。这里测：建组幂等、处理即 ack（失败也 ack）、并发派发的容量上限与
回填、认领路径的 in-flight 过滤与三分支清道夫处置、任务异常回收不悬空。
"""
import asyncio
import contextlib
import threading

import pytest
import redis as redis_lib

from agent import main_worker
from agent.main_worker import GROUP, claim_stale, ensure_group, handle_entry
from agent.runtime.channels import stream_key


class FakeRedis:
    """只实现 worker 用到的命令的最小假件。

    entries：喂给 xreadgroup 的消息队列，按 count 逐批吐出（模拟真实 Redis 遵守 COUNT，
    不会一次性把队列里的消息全倒出来）——并发派发的容量上限测试靠这个前提成立。
    """

    def __init__(self, *, busygroup: bool = False, autoclaim=("0-0", [], []), entries=None):
        self.busygroup = busygroup  # True 模拟组已存在（XGROUP CREATE 抛 BUSYGROUP）
        self.autoclaim_resp = autoclaim
        self.created: list[tuple] = []
        self.acked: list[tuple[str, str, str]] = []
        self._queue = list(entries or [])

    def xgroup_create(self, name, groupname, id="0", mkstream=False):
        if self.busygroup:
            raise redis_lib.exceptions.ResponseError("BUSYGROUP Consumer Group name already exists")
        self.created.append((name, groupname, id, mkstream))

    def xack(self, name, group, entry_id):
        self.acked.append((name, group, entry_id))

    def xautoclaim(self, name, group, consumer, min_idle_time=0, start_id="0-0", count=None):
        return self.autoclaim_resp

    def xreadgroup(self, group, consumer, streams, count=1, block=0):
        batch, self._queue = self._queue[:count], self._queue[count:]
        return [(stream_key(), batch)] if batch else []


@pytest.fixture
def ran(monkeypatch):
    """把 main_worker.process_run 换成记录器；calls 收集被执行的 run_id。"""
    calls: list[str] = []

    async def fake_process(run_id: str) -> None:
        calls.append(run_id)

    monkeypatch.setattr(main_worker, "process_run", fake_process)
    return calls


async def test_ensure_group_creates_from_zero_with_mkstream():
    r = FakeRedis()
    await ensure_group(r)
    # 从 0 建组 + MKSTREAM：回放建组前积压、stream 不存在也能建
    assert r.created == [(stream_key(), GROUP, "0", True)]


async def test_ensure_group_busygroup_is_idempotent():
    await ensure_group(FakeRedis(busygroup=True))  # 组已存在：吞掉不抛（重启幂等）


async def test_ensure_group_other_error_raises():
    class Boom(FakeRedis):
        def xgroup_create(self, *a, **kw):
            raise redis_lib.exceptions.ResponseError("NOAUTH Authentication required")

    with pytest.raises(redis_lib.exceptions.ResponseError):
        await ensure_group(Boom())


async def test_handle_entry_processes_then_acks(ran):
    r = FakeRedis()
    await handle_entry(r, "1-1", {"run_id": "r1"})
    assert ran == ["r1"]
    assert r.acked == [(stream_key(), GROUP, "1-1")]


async def test_handle_entry_acks_even_when_run_fails(monkeypatch):
    async def boom(run_id: str) -> None:
        raise RuntimeError("agent 炸了")

    monkeypatch.setattr(main_worker, "process_run", boom)
    r = FakeRedis()
    await handle_entry(r, "1-2", {"run_id": "r2"})  # 失败只打日志，不抛
    assert r.acked == [(stream_key(), GROUP, "1-2")]  # 照旧 ack：原地重试无意义


async def test_handle_entry_without_run_id_still_acks(ran):
    r = FakeRedis()
    await handle_entry(r, "1-3", {})  # 脏消息：不处理但要 ack，别永远滞留 pending
    await handle_entry(r, "1-4", None)  # xautoclaim 可能给 None fields（墓碑）
    assert ran == []
    assert [a[2] for a in r.acked] == ["1-3", "1-4"]


# ---------------------------------------------------------------------------
# 认领路径清道夫化（spec317）：过滤 in-flight → 剩下的按状态三分支处置，永不 process_run。
# ---------------------------------------------------------------------------

async def test_claim_stale_reaps_claimed_entries_never_calls_process_run(ran, monkeypatch):
    """既有测试语义翻转：认领到的消息不再交给 process_run 执行，而是走清道夫 reap_orphan_run。"""
    async def fake_reap(run_id):
        return "orphaned"

    monkeypatch.setattr(main_worker, "reap_orphan_run", fake_reap)
    # Redis 7 三元组返回形态（含已删除 id 列表）
    r = FakeRedis(autoclaim=("0-0", [("2-1", {"run_id": "r5"}), ("2-2", {"run_id": "r6"})], []))

    await claim_stale(r, "worker-a", inflight=set())

    assert ran == []  # 清道夫从不重新执行
    assert [a[2] for a in r.acked] == ["2-1", "2-2"]


async def test_claim_stale_redis62_two_tuple_form_still_supported(monkeypatch):
    async def fake_reap(run_id):
        return "terminal"

    monkeypatch.setattr(main_worker, "reap_orphan_run", fake_reap)
    r = FakeRedis(autoclaim=("0-0", [("3-1", {"run_id": "r7"})]))  # Redis 6.2 二元组形态

    await claim_stale(r, "worker-a", inflight=set())

    assert [a[2] for a in r.acked] == ["3-1"]


async def test_claim_stale_skips_inflight_entries(monkeypatch):
    """认领结果命中 in-flight 集合：本进程还在跑，跳过——不处置也不 ack，等属主任务自己收尾。"""
    calls = []

    async def fake_reap(run_id):
        calls.append(run_id)
        return "terminal"

    monkeypatch.setattr(main_worker, "reap_orphan_run", fake_reap)
    r = FakeRedis(autoclaim=("0-0", [("4-1", {"run_id": "r-inflight"})], []))

    await claim_stale(r, "worker-a", inflight={"4-1"})

    assert calls == []
    assert r.acked == []


async def test_claim_stale_dispositions_all_three_branches_all_ack(monkeypatch):
    """终态/孤儿/查无记录三分支都要 ack（区别只在是否调 finish_run，那属于 reap_orphan_run 自己的
    职责，这里只验证 claim_stale 对三种返回值一视同仁地记日志 + ack）。"""
    dispositions = {"r-terminal": "terminal", "r-orphan": "orphaned", "r-missing": "missing"}
    calls = []

    async def fake_reap(run_id):
        calls.append(run_id)
        return dispositions[run_id]

    monkeypatch.setattr(main_worker, "reap_orphan_run", fake_reap)
    r = FakeRedis(autoclaim=("0-0", [
        ("5-1", {"run_id": "r-terminal"}),
        ("5-2", {"run_id": "r-orphan"}),
        ("5-3", {"run_id": "r-missing"}),
    ], []))

    await claim_stale(r, "worker-a", inflight=set())

    assert calls == ["r-terminal", "r-orphan", "r-missing"]
    assert [a[2] for a in r.acked] == ["5-1", "5-2", "5-3"]


async def test_claim_stale_dirty_message_without_run_id_only_acks(monkeypatch):
    """没 run_id 的脏消息（远古/墓碑）：不查库、不调 reap_orphan_run，直接 ack（既有行为保留）。"""
    calls = []

    async def fake_reap(run_id):
        calls.append(run_id)
        return "missing"

    monkeypatch.setattr(main_worker, "reap_orphan_run", fake_reap)
    r = FakeRedis(autoclaim=("0-0", [("6-1", {}), ("6-2", None)], []))

    await claim_stale(r, "worker-a", inflight=set())

    assert calls == []
    assert [a[2] for a in r.acked] == ["6-1", "6-2"]


# ---------------------------------------------------------------------------
# 并发派发（run_loop）：容量上限 + 回填 + 任务异常回收。全靠事件握手，不用墙钟计时断言。
# ---------------------------------------------------------------------------

async def test_run_loop_caps_concurrent_dispatch_then_backfills(monkeypatch):
    """并发上限=2：3 条消息排队，同时在跑的最多 2 条；放行 1 条腾出容量后，第 3 条才被派发。"""
    monkeypatch.setattr(main_worker.settings, "agent_worker_concurrency", 2)

    release = {"r1": asyncio.Event(), "r2": asyncio.Event(), "r3": asyncio.Event()}
    running: set[str] = set()
    two_running = asyncio.Event()
    r3_started = asyncio.Event()

    async def fake_process(run_id):
        running.add(run_id)
        assert len(running) <= 2, "并发上限被突破"
        if len(running) == 2:
            two_running.set()
        if run_id == "r3":
            r3_started.set()
        await release[run_id].wait()
        running.discard(run_id)

    monkeypatch.setattr(main_worker, "process_run", fake_process)
    entries = [("1-1", {"run_id": "r1"}), ("1-2", {"run_id": "r2"}), ("1-3", {"run_id": "r3"})]
    r = FakeRedis(entries=entries)
    monkeypatch.setattr(main_worker, "get_redis", lambda: r)

    task = asyncio.create_task(main_worker.run_loop())
    try:
        await asyncio.wait_for(two_running.wait(), timeout=5)
        assert not r3_started.is_set()  # 容量满，第 3 条还没派发

        release["r1"].set()  # 放行一个，腾出容量
        await asyncio.wait_for(r3_started.wait(), timeout=5)
    finally:
        for ev in release.values():
            ev.set()  # 放行剩下的，别让子任务悬在 event loop 关闭时
        await asyncio.sleep(0.05)  # 给已放行的子任务一点时间跑完自己的 xack，避免悬空 task
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def test_run_loop_survives_xack_error_and_keeps_consuming(monkeypatch):
    """handle_entry 的 xack 抛 RedisError：该 task 的异常必须被回收环节显式消费（task.result()），
    不留"Task exception was never retrieved"；且不拖垮循环——下一条消息照样被处理。
    并发上限设为 1，让两条消息严格先后处理，避免和另一条消息的调度顺序产生歧义。"""
    monkeypatch.setattr(main_worker.settings, "agent_worker_concurrency", 1)
    processed: list[str] = []
    ok_seen = asyncio.Event()
    xack_ok_done = threading.Event()  # to_thread 跑在工作线程里：跨线程握手用 threading.Event

    async def fake_process(run_id):
        processed.append(run_id)
        if run_id == "ok-run":
            ok_seen.set()

    monkeypatch.setattr(main_worker, "process_run", fake_process)

    class _BoomOnceRedis(FakeRedis):
        def __init__(self, entries):
            super().__init__(entries=entries)
            self._boomed = False

        def xack(self, name, group, entry_id):
            if entry_id == "7-1" and not self._boomed:
                self._boomed = True
                raise redis_lib.exceptions.RedisError("xack 网络瞬断")
            super().xack(name, group, entry_id)
            if entry_id == "7-2":
                xack_ok_done.set()

    entries = [("7-1", {"run_id": "boom-run"}), ("7-2", {"run_id": "ok-run"})]
    r = _BoomOnceRedis(entries)
    monkeypatch.setattr(main_worker, "get_redis", lambda: r)

    task = asyncio.create_task(main_worker.run_loop())
    try:
        await asyncio.wait_for(ok_seen.wait(), timeout=5)
        assert processed == ["boom-run", "ok-run"]
        # 等第二条真正 xack 成功收尾，确保没有子任务在取消时还悬着
        assert await asyncio.to_thread(xack_ok_done.wait, 5)
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
