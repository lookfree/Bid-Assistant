"""Worker 角色入口：消费队列、跑图、回传进度（spec103/104 实现）。
本 spec 仅建立可启动的骨架：等依赖就绪后挂起。"""
import time

from agent.config import settings
from agent import db, redis_client


def wait_for_deps(retries: int = 30, delay: float = 2.0) -> None:
    """等 PG/Redis 就绪；中间件晚起/瞬断时重试，超时才抛（显式 raise，不用 assert——-O 会剥离 assert）。"""
    for _ in range(retries):
        if db.ping() and redis_client.ping():
            return
        time.sleep(delay)
    raise RuntimeError("依赖(PG/Redis)在超时内未就绪")


def main() -> None:
    wait_for_deps()
    # flush：长驻进程 stdout 是块缓冲，不 flush 启动日志会卡在缓冲区不落盘。
    print(f"[worker] up, env={settings.env}, prefix={settings.redis_prefix} (消费逻辑见 spec103)", flush=True)
    try:
        # spec103/104：从 Redis Stream 消费 run 任务并执行
        while True:
            time.sleep(3600)
    finally:
        db.close_pool()
        redis_client.close_redis()


if __name__ == "__main__":
    main()
