"""Worker 角色入口：消费队列、跑图、回传进度（spec103/104 实现）。
本 spec 仅建立可启动的骨架：连通依赖后等待。"""
import time
from agent.config import settings
from agent import db, redis_client


def main() -> None:
    assert db.ping(), "PG 不可达"
    assert redis_client.ping(), "Redis 不可达"
    # flush：长驻进程 stdout 是块缓冲，不 flush 启动日志会卡在缓冲区不落盘。
    print(f"[worker] up, env={settings.env}, prefix={settings.redis_prefix} (消费逻辑见 spec103)", flush=True)
    # spec103/104：从 Redis Stream 消费 run 任务并执行
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
