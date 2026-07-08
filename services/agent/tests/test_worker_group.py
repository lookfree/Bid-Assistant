"""main_worker consumer group 消费的单测：不连真 Redis，最小 fake + monkeypatch process_run。

背景：旧实现 XREAD last_id="$" 只读订阅后的新消息，worker 重启窗口内入队的 run 永远不被消费
（生产实测积压 12 条，页面永久 running）。改 consumer group 后：游标持久、处理完 XACK、
XAUTOCLAIM 认领死消费者 pending。这里测三个关键行为：建组幂等、处理即 ack（失败也 ack）、认领即处理。
"""
import pytest
import redis as redis_lib

from agent import main_worker
from agent.main_worker import GROUP, claim_stale, ensure_group, handle_entry
from agent.runtime.channels import stream_key


class FakeRedis:
    """只实现 worker 用到的命令的最小假件。"""

    def __init__(self, *, busygroup: bool = False, autoclaim=("0-0", [], [])):
        self.busygroup = busygroup  # True 模拟组已存在（XGROUP CREATE 抛 BUSYGROUP）
        self.autoclaim_resp = autoclaim
        self.created: list[tuple] = []
        self.acked: list[tuple[str, str, str]] = []

    def xgroup_create(self, name, groupname, id="0", mkstream=False):
        if self.busygroup:
            raise redis_lib.exceptions.ResponseError("BUSYGROUP Consumer Group name already exists")
        self.created.append((name, groupname, id, mkstream))

    def xack(self, name, group, entry_id):
        self.acked.append((name, group, entry_id))

    def xautoclaim(self, name, group, consumer, min_idle_time=0, start_id="0-0", count=None):
        return self.autoclaim_resp


@pytest.fixture
def ran(monkeypatch):
    """把 main_worker.process_run 换成记录器；calls 收集被执行的 run_id。"""
    calls: list[str] = []

    async def fake_process(run_id: str) -> None:
        calls.append(run_id)

    monkeypatch.setattr(main_worker, "process_run", fake_process)
    return calls


def test_ensure_group_creates_from_zero_with_mkstream():
    r = FakeRedis()
    ensure_group(r)
    # 从 0 建组 + MKSTREAM：回放建组前积压、stream 不存在也能建
    assert r.created == [(stream_key(), GROUP, "0", True)]


def test_ensure_group_busygroup_is_idempotent():
    ensure_group(FakeRedis(busygroup=True))  # 组已存在：吞掉不抛（重启幂等）


def test_ensure_group_other_error_raises():
    class Boom(FakeRedis):
        def xgroup_create(self, *a, **kw):
            raise redis_lib.exceptions.ResponseError("NOAUTH Authentication required")

    with pytest.raises(redis_lib.exceptions.ResponseError):
        ensure_group(Boom())


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


async def test_claim_stale_processes_and_acks_claimed(ran):
    # Redis 7 三元组返回形态（含已删除 id 列表）
    r = FakeRedis(autoclaim=("0-0", [("2-1", {"run_id": "r5"}), ("2-2", {"run_id": "r6"})], []))
    await claim_stale(r, "worker-a")
    assert ran == ["r5", "r6"]
    assert [a[2] for a in r.acked] == ["2-1", "2-2"]


async def test_claim_stale_redis62_two_tuple_form(ran):
    r = FakeRedis(autoclaim=("0-0", [("3-1", {"run_id": "r7"})]))  # Redis 6.2 二元组形态
    await claim_stale(r, "worker-a")
    assert ran == ["r7"]
