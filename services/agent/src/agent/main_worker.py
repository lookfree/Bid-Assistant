"""Worker 角色入口：等依赖就绪 → 消费 Redis Stream（consumer group）→ process_run（执行 run）。"""
import asyncio
import socket
import time

import redis as redis_lib

from agent import db, redis_client
from agent.redis_client import get_redis
from agent.runtime.channels import stream_key
from agent.runtime.executor import process_run

# consumer group 消费（替代旧 XREAD last_id="$"）：
# "$" 只读订阅之后的新消息——worker 重启窗口内入队的 run 永远不被消费（生产实测积压 12 条，
# 页面永久 running）。group 的消费游标持久在 Redis 侧：重启从上次 ack 位置继续，不丢窗口消息；
# 处理完 XACK，配合 XAUTOCLAIM 认领死消费者名下的 pending，worker 崩溃也不丢单。
GROUP = "workers"
# pending 空闲超 60s 视为死消费者遗留。当前单 worker 部署安全（自己在跑的 run 不会被自己认领——
# 消费循环是串行的）；多实例扩容前需评估长 run（content 步可达数分钟）被别的实例误认领的风险。
CLAIM_MIN_IDLE_MS = 60_000
CLAIM_EVERY_S = 60.0  # 认领扫描周期（循环内到点才扫，启动即首扫一次）


def wait_for_deps(retries: int = 30, delay: float = 2.0) -> None:
    """等 PG/Redis 就绪；中间件晚起/瞬断时重试，超时才抛（显式 raise，不用 assert——-O 会剥离 assert）。"""
    for _ in range(retries):
        if db.ping() and redis_client.ping():
            return
        time.sleep(delay)
    raise RuntimeError("依赖(PG/Redis)在超时内未就绪")


def ensure_group(r) -> None:
    """建 consumer group（幂等：已存在的 BUSYGROUP 吞掉，其余照抛）。
    id="0" 从头建组：会回放建组前的存量积压——积压 run 的 runmeta 多已过期，
    process_run 对缺 meta 的 run 快速标失败，可接受（正好清掉页面永久 running 的死单）。"""
    try:
        r.xgroup_create(stream_key(), GROUP, id="0", mkstream=True)
    except redis_lib.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


async def handle_entry(r, entry_id: str, fields: dict | None) -> None:
    """处理一条消息并 XACK。run 失败照旧只打日志也 ack（原地重试无意义，runmeta 缺失有快速失败兜底）；
    xack 本身抛错则消息留在 pending，60s 后由 XAUTOCLAIM 重新认领（至多重复执行一次，可接受）。"""
    run_id = (fields or {}).get("run_id")
    if run_id:
        try:
            await process_run(run_id)
        except Exception as e:  # noqa: BLE001 单个 run 失败不拖垮消费循环
            print(f"[worker] run {run_id} failed: {e}", flush=True)
    r.xack(stream_key(), GROUP, entry_id)


async def claim_stale(r, consumer: str) -> None:
    """XAUTOCLAIM 认领死消费者名下空闲超阈值的 pending 并处理（worker 崩溃不丢单）。
    一次最多 10 条，剩余的下个周期继续（不长时间挡住新消息）。
    返回值兼容 Redis 6.2（二元组）与 7（三元组，含已删除 id 列表）：都取下标 1 的消息列表。"""
    resp = r.xautoclaim(stream_key(), GROUP, consumer, min_idle_time=CLAIM_MIN_IDLE_MS, start_id="0-0", count=10)
    for entry_id, fields in resp[1]:
        await handle_entry(r, entry_id, fields)


async def run_loop() -> None:
    r = get_redis()
    ensure_group(r)
    consumer = socket.gethostname()  # 容器内 hostname 即容器 id，天然区分实例
    print(f"[worker] consuming {stream_key()} (group={GROUP}, consumer={consumer}) ...", flush=True)
    last_claim = 0.0
    while True:
        try:
            if time.monotonic() - last_claim >= CLAIM_EVERY_S:
                last_claim = time.monotonic()
                await claim_stale(r, consumer)
            resp = r.xreadgroup(GROUP, consumer, {stream_key(): ">"}, count=1, block=5000)
            for _stream, entries in resp or []:
                for entry_id, fields in entries:
                    await handle_entry(r, entry_id, fields)
        except redis_lib.exceptions.RedisError as e:
            # 远程 Redis 瞬断/读超时不打崩消费循环：稍候重连重读（redis-py 会自动重建连接）
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
