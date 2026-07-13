"""tender chunks 每日清扫——TTL 取自配置;单次失败只记日志,循环不退出。"""
import asyncio

import agent.rag.sweep as sweep


def test_sweep_once_loops_batches_until_drained(monkeypatch):
    """满批 → 继续下一批;不足一批 → 删净返回总数。批间是 await 点,关停可取消。"""
    calls = {"ttl": None, "batches": []}
    returns = [sweep.store.SWEEP_BATCH_LIMIT, 3]

    def fake_sweep(pool, ttl_days):
        calls["ttl"] = ttl_days
        n = returns.pop(0)
        calls["batches"].append(n)
        return n

    monkeypatch.setattr(sweep.store, "sweep_expired_tender", fake_sweep)
    monkeypatch.setattr(sweep, "get_pool", lambda: object())
    n = asyncio.run(sweep.sweep_once())
    assert n == sweep.store.SWEEP_BATCH_LIMIT + 3
    assert calls["batches"] == [sweep.store.SWEEP_BATCH_LIMIT, 3]
    assert calls["ttl"] == sweep.settings.rag_tender_ttl_days


def test_sweep_loop_survives_single_failure(monkeypatch):
    calls = {"n": 0}

    async def boom():
        calls["n"] += 1
        raise RuntimeError("db down")

    async def cancel_sleep(_s):
        raise asyncio.CancelledError

    monkeypatch.setattr(sweep, "sweep_once", boom)
    monkeypatch.setattr(sweep.asyncio, "sleep", cancel_sleep)
    try:
        asyncio.run(sweep.sweep_loop())
    except asyncio.CancelledError:
        pass
    # 异常被吞、循环走到了 sleep（而不是因单次失败退出）
    assert calls["n"] == 1
