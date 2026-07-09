"""Worker 角色入口：等依赖就绪 → 并发消费 Redis Stream（consumer group）→ process_run（执行 run）。"""
import asyncio
import socket
import time

import redis as redis_lib

from agent import db, redis_client
from agent.config import settings
from agent.redis_client import get_redis
from agent.runtime.channels import stream_key
from agent.runtime.executor import process_run, reap_orphan_run

# consumer group 消费（替代旧 XREAD last_id="$"）：
# "$" 只读订阅之后的新消息——worker 重启窗口内入队的 run 永远不被消费（生产实测积压 12 条，
# 页面永久 running）。group 的消费游标持久在 Redis 侧：重启从上次 ack 位置继续，不丢窗口消息；
# 处理完 XACK，配合 XAUTOCLAIM 认领死消费者名下的 pending，worker 崩溃也不丢单。
GROUP = "workers"
# idle 超 60s 且不在本进程 in-flight 集合 = 孤儿（单实例部署下属主进程必已消亡），
# 清道夫标失败清理（spec317：认领路径不再重试执行，见 claim_stale）。多实例部署前必须重估——
# in-flight 过滤跨不了进程，会把其它实例仍在正常跑的 run 误判孤儿，需加心跳列或大幅上调阈值。
CLAIM_MIN_IDLE_MS = 60_000
CLAIM_EVERY_S = 60.0  # 认领扫描周期（循环内到点才扫，启动即首扫一次）


def wait_for_deps(retries: int = 30, delay: float = 2.0) -> None:
    """等 PG/Redis 就绪；中间件晚起/瞬断时重试，超时才抛（显式 raise，不用 assert——-O 会剥离 assert）。"""
    for _ in range(retries):
        if db.ping() and redis_client.ping():
            return
        time.sleep(delay)
    raise RuntimeError("依赖(PG/Redis)在超时内未就绪")


async def ensure_group(r) -> None:
    """建 consumer group（幂等：已存在的 BUSYGROUP 吞掉，其余照抛）。
    id="0" 从头建组：会回放建组前的存量积压——积压 run 的 runmeta 多已过期，
    process_run 对缺 meta 的 run 快速标失败，可接受（正好清掉页面永久 running 的死单）。
    r.xgroup_create 同步 Redis 调用，to_thread 卸载（和其它调用点保持一致的卸载纪律）。"""
    try:
        await asyncio.to_thread(r.xgroup_create, stream_key(), GROUP, id="0", mkstream=True)
    except redis_lib.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


async def handle_entry(r, entry_id: str, fields: dict | None) -> None:
    """处理一条消息并 XACK。run 失败照旧只打日志也 ack（原地重试无意义，runmeta 缺失有快速失败兜底）；
    xack 本身抛错则异常悬在这个 task 上，交给 run_loop 的回收环节显式消费——消息留在 pending，
    由认领路径（清道夫）兜底收尾，不重复执行。"""
    run_id = (fields or {}).get("run_id")
    if run_id:
        try:
            await process_run(run_id)
        except Exception as e:  # noqa: BLE001 单个 run 失败不拖垮消费循环
            print(f"[worker] run {run_id} failed: {e}", flush=True)
    await asyncio.to_thread(r.xack, stream_key(), GROUP, entry_id)


async def claim_stale(r, consumer: str, inflight: set[str]) -> None:
    """XAUTOCLAIM 扫描死消费者名下 idle 超阈值的 pending，做孤儿清理（清道夫），永不重新执行。
    一次最多 10 条，剩余的下个周期继续（不长时间挡住新消息）。
    返回值兼容 Redis 6.2（二元组）与 7（三元组，含已删除 id 列表）：都取下标 1 的消息列表。

    先按 in-flight 集合过滤：命中的 entry_id 是本进程正在跑的 run，idle 超阈值只是因为
    并发派发下"读取新消息"和"这条还没跑完"天然并发（不像串行模型靠"卡在 await 里"免疫），
    跳过、不处置也不 ack，等属主任务自己收尾。过滤剩下的在单实例部署下属主进程必已消亡，
    是真孤儿——查库按状态分三类处置（reap_orphan_run），任何分支都不调 process_run：
    重试语义属于 App 层（用户重新点击产生新 run_id）+ checkpointer 续跑（spec317 决策记录 §3）。
    没 run_id 的脏消息（远古/墓碑）不查库，直接 ack。"""
    resp = await asyncio.to_thread(
        r.xautoclaim, stream_key(), GROUP, consumer, min_idle_time=CLAIM_MIN_IDLE_MS, start_id="0-0", count=10,
    )
    for entry_id, fields in resp[1]:
        if entry_id in inflight:
            continue
        run_id = (fields or {}).get("run_id")
        if run_id:
            disposition = await reap_orphan_run(run_id)
            print(f"[worker] claim {entry_id} run={run_id}: {disposition}", flush=True)
        else:
            print(f"[worker] claim {entry_id}: no run_id, dropping stale/dirty message", flush=True)
        await asyncio.to_thread(r.xack, stream_key(), GROUP, entry_id)


def _reap_done_tasks(pending: set, entry_of: dict, inflight: set) -> None:
    """把已完成的 task 从 pending/in-flight 摘除；task.result() 显式取出异常记日志——
    handle_entry 里 process_run 的异常已自吞，但 xack 抛 RedisError 会悬在 task 上
    （"Task exception was never retrieved"），必须显式消费。该消息留在 pending（未 ack），
    由认领路径的清道夫兜底收尾，消费循环本身不受影响。"""
    done = [t for t in pending if t.done()]
    for task in done:
        pending.discard(task)
        entry_id = entry_of.pop(task, None)
        if entry_id is not None:
            inflight.discard(entry_id)
        try:
            task.result()
        except Exception as e:  # noqa: BLE001 已记录，不让异常悬在 task 上
            print(f"[worker] handle_entry task raised: {e}", flush=True)


async def _dispatch_batch(r, consumer: str, capacity: int, pending: set, entry_of: dict, inflight: set) -> None:
    """有容量才读：xreadgroup 卸载到线程池，count=capacity 保证一次最多读进能吃下的量。
    每条消息先登记 in-flight（entry_id），派发 task 加入 pending——登记先于 create_task，
    避免清道夫在极短窗口内把刚派发、还没登记的消息误判孤儿。"""
    resp = await asyncio.to_thread(
        r.xreadgroup, GROUP, consumer, {stream_key(): ">"}, count=capacity, block=5000,
    )
    for _stream, entries in resp or []:
        for entry_id, fields in entries:
            inflight.add(entry_id)
            task = asyncio.create_task(handle_entry(r, entry_id, fields))
            entry_of[task] = entry_id
            pending.add(task)


async def _await_capacity(pending: set) -> None:
    """容量已满：等至少一个任务完成腾位置，超时 5s 保证 claim_stale 的周期检查不被无限阻塞。"""
    if pending:
        await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED, timeout=5)


async def run_loop() -> None:
    """信号量限流的并发派发：容量(agent_worker_concurrency)内尽量多读、多个 run 同时跑；
    容量满时等一个任务完成腾位置；定期认领孤儿（不重执行，见 claim_stale）。
    pending/entry_of/inflight 是一份状态：task 创建时登记，回收时一起摘除。"""
    r = get_redis()
    await ensure_group(r)
    consumer = socket.gethostname()  # 容器内 hostname 即容器 id，天然区分实例
    print(f"[worker] consuming {stream_key()} (group={GROUP}, consumer={consumer}) ...", flush=True)
    last_claim = 0.0
    pending: set[asyncio.Task] = set()
    entry_of: dict[asyncio.Task, str] = {}
    inflight: set[str] = set()
    while True:
        try:
            if time.monotonic() - last_claim >= CLAIM_EVERY_S:
                last_claim = time.monotonic()
                await claim_stale(r, consumer, inflight)
            capacity = settings.agent_worker_concurrency - len(pending)
            if capacity > 0:
                await _dispatch_batch(r, consumer, capacity, pending, entry_of, inflight)
            else:
                await _await_capacity(pending)
            _reap_done_tasks(pending, entry_of, inflight)
        except redis_lib.exceptions.RedisError as e:
            # 远程 Redis 瞬断/读超时不打崩消费循环：稍候重连重读（redis-py 会自动重建连接）。
            # pending 里在跑的任务不受影响——这里只是本轮读/认领失败，不取消也不丢弃它们。
            print(f"[worker] redis 瞬断，重试: {e}", flush=True)
            await asyncio.sleep(2)


def main() -> None:
    wait_for_deps()
    try:
        asyncio.run(run_loop())
    finally:
        db.close_pool()
        redis_client.close_redis()


if __name__ == "__main__":
    main()
