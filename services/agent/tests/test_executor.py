import asyncio
import json
import threading

from agent.db import get_pool
from agent.redis_client import get_redis
from agent.runtime import executor as executor_mod
from agent.runtime.dispatch import create_run
from agent.runtime.executor import process_run
from agent.runtime.channels import progress_stream, result_key


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
