from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import httpx

from agent.config import settings
from agent.db import get_pool
from agent.redis_client import get_redis
from agent.telemetry.recorder import Recorder
from agent.models.gateway import ModelGateway, model_override_to_settings
from agent.runtime.channels import GROUP, heartbeat_key, progress_stream, runmeta_key, result_key, stream_key
from agent.runtime.registry import get_agent, RunContext
import agent.runtime.dummy_agent  # noqa: F401 确保 dummy 注册
import agent.agents.bidding_agent  # noqa: F401 注册 agent_type="bidding_agent"

_gateway = ModelGateway(settings)          # 无副作用
_recorder: Recorder | None = None           # 惰性：import 期不连库


def _rec() -> Recorder:
    global _recorder
    if _recorder is None:
        _recorder = Recorder(get_pool())
    return _recorder


def _publish(r, run_id: str, event: dict) -> None:
    # 进度落 Redis Stream（持久、可回放）：晚订阅/断线重连的 SSE 客户端能从头 XREAD 拿全过程。
    # xadd + expire(24h，随 result 过期防堆积) + 心跳续期(spec318) 用同一 pipeline 合成一次往返。
    # 心跳搭 run.start/每个节点事件的顺风车续期——run 存活期间必然持续发事件，这是最省事的存活证明
    # 落点：孤儿清道夫（sweep_stale_runs）靠它区分"running 状态但 worker 已死"和"仍在正常跑"。
    key = progress_stream(run_id)
    pipe = r.pipeline()
    pipe.xadd(key, {"event": json.dumps(event)})
    pipe.expire(key, 86400)
    pipe.set(heartbeat_key(run_id), "1", ex=settings.run_heartbeat_ttl_s)
    pipe.execute()


async def _apublish(r, run_id: str, event: dict) -> None:
    # _publish 是同步 Redis 网络 IO；卸载到线程池，避免多 run 并发时占住事件循环卡住其他 run。
    await asyncio.to_thread(_publish, r, run_id, event)


async def _heartbeat_pump(r, run_id: str) -> None:
    """独立心跳泵（spec318 修正）：run 存活期间每 ttl/3 秒续期 run:hb:<run_id>，与事件解耦。
    关键——单个节点（如 content deepagent 3~8 分钟）执行期间 astream 不产事件，若心跳只搭事件
    顺风车续期，会在节点内途中过期，被其它副本的 sweep_stale_runs 误判为孤儿而杀掉正在跑的 run。
    多节点部署下这是致命竞态：泵保证只要 worker 进程活着、run 在跑，心跳就一直新鲜。"""
    interval = max(10, settings.run_heartbeat_ttl_s // 3)
    try:
        while True:
            await asyncio.to_thread(r.set, heartbeat_key(run_id), "1", ex=settings.run_heartbeat_ttl_s)
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        pass  # run 结束（正常/异常）即取消，不再续期 → 心跳到期后 sweeper 才可回收真孤儿


async def process_run(run_id: str) -> None:
    """执行单个 run：跑 agent 的 astream → 逐事件埋点 + 推进度流 → 结果落 Redis → finish + 用量回调。
    事件契约 {type,data,node?}：node.start/node.end/step.done/error 落 event_log；
    结果取自 node.end.data.result（单循环）或 step.done.data.result（工作流每步）。
    同一路径上所有同步 Redis/PG 调用都经 asyncio.to_thread 卸载——worker 支持多 run 并发后，
    直接跑在事件循环上的同步调用会独占循环，卡住其它并发中的 run。"""
    r = get_redis()
    rec = _rec()
    raw_meta = await asyncio.to_thread(r.get, runmeta_key(run_id))
    meta = json.loads(raw_meta or "{}")
    agent_type, thread_id, input = meta.get("agent_type"), meta.get("thread_id", run_id), meta.get("input", {})
    user_id = meta.get("user_id")

    if not agent_type:
        # runmeta 丢失/过期（>24h 积压等）：直接标失败，别让 NOT NULL agent_type 崩在 start_run 而留孤儿。
        await asyncio.to_thread(rec.finish_run, run_id, status="failed",
                                 error="runmeta missing or expired", error_type="MetaMissing")
        await _apublish(r, run_id, {"type": "run.end", "data": {"status": "failed", "error": "runmeta missing or expired"}})
        return

    await asyncio.to_thread(rec.start_run, run_id, agent_type, thread_id)
    await asyncio.to_thread(rec.log_event, run_id, agent_type, "run.start", thread_id=thread_id)
    await _apublish(r, run_id, {"type": "run.start"})

    model = meta.get("model")
    override = model_override_to_settings(model)
    # 有 per-run override 才新建 gateway；否则复用模块级单例 _gateway（零额外开销）
    gateway = ModelGateway(settings.model_copy(update=override)) if override else _gateway
    ctx = RunContext(run_id=run_id, agent_type=agent_type, thread_id=thread_id,
                     recorder=rec, gateway=gateway, redis=r, user_id=user_id)
    result = None
    nodes = set()
    # 独立心跳泵：run 全程续期，与节点事件解耦（防长节点途中心跳过期被误回收）。
    hb_pump = asyncio.create_task(_heartbeat_pump(r, run_id))
    try:
        agent = get_agent(agent_type)
        async for ev in agent.astream(input, ctx):
            if ev.get("node"):
                nodes.add(ev["node"])
            if ev["type"] in ("node.start", "node.end", "step.done", "error"):
                await asyncio.to_thread(rec.log_event, run_id, agent_type, ev["type"], node=ev.get("node"),
                                         data=ev.get("data"), thread_id=thread_id)
            # 单循环 agent 结果在 node.end.data.result；工作流每步结果在 step.done.data.result。
            if ev["type"] in ("node.end", "step.done") and isinstance(ev.get("data"), dict) and "result" in ev["data"]:
                result = ev["data"]["result"]
            await _apublish(r, run_id, ev)  # 全部事件推 SSE

        # finish 先行：finish_run 成功后再落 result，避免 finish 抛错时留下"结果在、状态却不是 succeeded"。
        await asyncio.to_thread(rec.finish_run, run_id, status="succeeded", node_count=len(nodes))
        await asyncio.to_thread(r.set, result_key(run_id), json.dumps(result), ex=86400)
        await _apublish(r, run_id, {"type": "run.end", "data": {"status": "succeeded"}})
        await _callback(run_id, agent_type, "succeeded")
    except Exception as e:  # noqa: BLE001
        await asyncio.to_thread(rec.log_event, run_id, agent_type, "error", level="error",
                                 data={"error": str(e)}, thread_id=thread_id)
        await asyncio.to_thread(rec.finish_run, run_id, status="failed",
                                 error=str(e), error_type=type(e).__name__)
        await _apublish(r, run_id, {"type": "run.end", "data": {"status": "failed", "error": str(e)}})
        await _callback(run_id, agent_type, "failed")
    finally:
        # run 落终态后立即停泵：心跳自然到期,真孤儿(worker 崩溃时泵随进程消失)才能被 sweeper 回收。
        hb_pump.cancel()
        await asyncio.gather(hb_pump, return_exceptions=True)


async def _terminate_run(rec: Recorder, r, run_id: str, error: str, error_type: str) -> None:
    """标失败 + 发 run.end failed——认领清道夫(reap_orphan_run)和心跳清道夫(sweep_stale_runs)
    共用的终态化收尾：任何一条附着的 SSE relay 都靠这个事件结束等待。"""
    await asyncio.to_thread(rec.finish_run, run_id, status="failed", error=error, error_type=error_type)
    await _apublish(r, run_id, {"type": "run.end", "data": {"status": "failed", "error": error}})


async def reap_orphan_run(run_id: str) -> str:
    """清道夫处置一个认领到的孤儿 run，返回处置类别 "terminal"|"orphaned"|"missing"。
    永不重新执行——重试语义属于 App 层（新 run_id）+ checkpointer（spec317 决策记录 §3）。"""
    rec = _rec()
    status = await asyncio.to_thread(rec.run_status, run_id)
    if status in ("succeeded", "failed"):
        return "terminal"
    if status is None:
        return "missing"
    await _terminate_run(rec, get_redis(), run_id, "orphaned: worker exited mid-run", "Orphaned")
    return "orphaned"


def _pending_run_ids(r) -> set[str]:
    """当前"已投递未 ack"的 stream 条目（含真正 in-flight 和挂起认领）映射出的 run_id 集合。
    queued 超时判"消息是否丢失"要排除掉这些——它们仍在正常处理链路上，不是孤儿。
    XPENDING 只给 entry id，不带 fields，逐条 XRANGE 取 run_id；pending 条目数天然有界
    （受并发度/CLAIM_MIN_IDLE_MS 约束），这里的逐条查询不是无界扫描。"""
    entries = r.xpending_range(stream_key(), GROUP, min="-", max="+", count=1000)
    run_ids: set[str] = set()
    for e in entries:
        msg_id = e["message_id"] if isinstance(e, dict) else e[0]
        for _id, fields in r.xrange(stream_key(), min=msg_id, max=msg_id):
            rid = (fields or {}).get("run_id")
            if rid:
                run_ids.add(rid)
    return run_ids


def _sid_le(a: str, b: str) -> bool:
    """stream id 比较 a ≤ b：id 形如 "ms-seq"，按 (ms, seq) 数值序比。解析异常 → False（保守不回收）。"""
    try:
        am, asq = (int(x) for x in a.split("-", 1))
        bm, bsq = (int(x) for x in b.split("-", 1))
        return (am, asq) <= (bm, bsq)
    except (ValueError, AttributeError):
        return False


def _group_last_delivered(r) -> str | None:
    """消费组 last-delivered-id 游标：queued 清道夫据此区分「已投递卡住」和「未投递排队」。"""
    for g in r.xinfo_groups(stream_key()):
        name = g.get("name")
        name = name.decode() if isinstance(name, bytes) else name
        if name == GROUP:
            lid = g.get("last-delivered-id")
            return lid.decode() if isinstance(lid, bytes) else lid
    return None


def _run_entry_id(r, run_id: str) -> str | None:
    """从 runmeta 取该 run 的 stream entry_id（dispatch 时 xadd 返回并存入）。"""
    raw = r.get(runmeta_key(run_id))
    if not raw:
        return None
    return json.loads(raw).get("entry_id")


async def sweep_stale_runs() -> dict[str, int]:
    """心跳清道夫（spec318）：补 XAUTOCLAIM 认领路径够不到的两个死角——
    ① running 但 stream 条目已 ack（心跳是唯一存活证明，无心跳 = worker 中断，孤儿回收）；
    ② queued 超 QUEUED_STALE_S 且 stream 侧找不到对应 pending 条目（消息丢失/从未真正入队处理）。
    永不重新执行，同 reap_orphan_run 的决策；直接查 agent_request（running/queued 状态的权威
    来源）而非另建 Redis 注册表或 SCAN，枚举成本可控（该状态集合本身就小）。

    整体失败与逐条失败都按 claim_stale 的隔离纪律处理：任何一步（列举/心跳查询/单条终态化）
    出错都只打日志、不冒泡——这是 run_loop 每个周期都会调用的路径，PG/Redis 瞬断不该打崩
    整个 worker 消费循环，下个周期自然重试。"""
    running_reaped = queued_reaped = 0
    try:
        rec = _rec()
        rows = await asyncio.to_thread(rec.list_active_runs)
        if not rows:
            return {"running_reaped": 0, "queued_reaped": 0}
        r = get_redis()
        pending_run_ids = await asyncio.to_thread(_pending_run_ids, r)
        last_delivered = await asyncio.to_thread(_group_last_delivered, r)
    except Exception as e:  # noqa: BLE001 列举本身失败：本周期跳过，下个周期重试
        print(f"[worker] sweep_stale_runs 列举失败，跳过本轮: {e}", flush=True)
        return {"running_reaped": 0, "queued_reaped": 0}

    now = datetime.now(timezone.utc)
    for run_id, status, created_at in rows:
        try:
            if status == "running":
                alive = await asyncio.to_thread(r.exists, heartbeat_key(run_id))
                if not alive:
                    await _terminate_run(rec, r, run_id, "worker 中断，run 孤儿回收", "HeartbeatMissing")
                    running_reaped += 1
            elif status == "queued":
                age_s = (now - created_at).total_seconds()
                if age_s < settings.queued_stale_s or run_id in pending_run_ids:
                    continue
                # 只回收「已投递却卡住」的：entry_id ≤ 消费组游标 = 消息已被读走却没进 running（投递后
                # worker 在 ack 与 start_run 之间崩溃等）。entry_id > 游标 = 尚未投递,只是积压排队,
                # 迟早会被消费——绝不能杀（评审 Important：饱和积压下会误杀正常排队 run）。
                entry_id = await asyncio.to_thread(_run_entry_id, r, run_id)
                delivered = bool(entry_id and last_delivered and _sid_le(entry_id, last_delivered))
                if delivered:
                    await _terminate_run(rec, r, run_id, "排队丢失，已回收", "QueuedStale")
                    queued_reaped += 1
        except Exception as e:  # noqa: BLE001 单条失败不拖垮整轮扫描，下个周期重试
            print(f"[worker] sweep_stale_runs run={run_id} 处置失败: {e}", flush=True)
    return {"running_reaped": running_reaped, "queued_reaped": queued_reaped}


async def _callback(run_id: str, agent_type: str, status: str) -> None:
    if not settings.app_callback_url:
        return
    try:
        # usage_summary 查库也纳入这个 try：它和 httpx POST 一样只是"上报"，瞬时 PG 错误不该
        # 冒出去覆写 process_run 里已经落定的 succeeded 状态（见 process_run 里 _callback 的调用位置）。
        usage = await asyncio.to_thread(_rec().usage_summary, run_id)
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(settings.app_callback_url, json={"run_id": run_id, "agent_type": agent_type,
                                                          "status": status, "usage": usage})
    except Exception:  # noqa: BLE001
        pass  # 回调失败不阻断；App 侧另有对账
