"""Worker 角色入口：等依赖就绪 → 消费 Redis Stream → process_run（执行 run）。"""
import asyncio
import time

import redis as redis_lib

from agent import db, redis_client
from agent.redis_client import get_redis
from agent.runtime.channels import stream_key
from agent.runtime.executor import process_run


def wait_for_deps(retries: int = 30, delay: float = 2.0) -> None:
    """等 PG/Redis 就绪；中间件晚起/瞬断时重试，超时才抛（显式 raise，不用 assert——-O 会剥离 assert）。"""
    for _ in range(retries):
        if db.ping() and redis_client.ping():
            return
        time.sleep(delay)
    raise RuntimeError("依赖(PG/Redis)在超时内未就绪")


async def run_loop() -> None:
    r = get_redis()
    last_id = "$"  # 只读新消息（生产用 consumer group XREADGROUP+ack 保不丢/可水平扩，留 spec107 加固）
    print(f"[worker] consuming {stream_key()} ...", flush=True)
    while True:
        try:
            resp = r.xread({stream_key(): last_id}, count=1, block=5000)
        except redis_lib.exceptions.RedisError as e:
            # 远程 Redis 瞬断/读超时不打崩消费循环：稍候重连重读（redis-py 会自动重建连接）
            print(f"[worker] redis 瞬断，重试: {e}", flush=True)
            await asyncio.sleep(2)
            continue
        if not resp:
            continue
        for _stream, entries in resp:
            for entry_id, fields in entries:
                last_id = entry_id
                run_id = fields.get("run_id")
                if run_id:
                    try:
                        await process_run(run_id)
                    except Exception as e:  # noqa: BLE001 单个 run 失败不拖垮消费循环
                        print(f"[worker] run {run_id} failed: {e}", flush=True)


def main() -> None:
    wait_for_deps()
    try:
        asyncio.run(run_loop())
    finally:
        db.close_pool()
        redis_client.close_redis()


if __name__ == "__main__":
    main()
