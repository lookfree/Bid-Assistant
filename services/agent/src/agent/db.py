import logging

from psycopg_pool import ConnectionPool

from agent.config import settings

logger = logging.getLogger(__name__)

# 惰性单例：首次使用才建/开连接池（import 无副作用，对齐 apps/api 的 getDb）。
_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        # 池上限跟随 worker 并发上限增长：每个在跑 run 占一条连接，外加清道夫/checkpointer 的余量；
        # 取 floor 10 保证 api 角色与低并发配置不缩水（spec317）。
        max_size = max(10, settings.agent_worker_concurrency + 4)
        # open=False + 显式 open()：避免构造参数 open=True 的弃用告警。
        # check=check_connection：借出前先探活,淘汰网络抖动留下的坏连接(WAN 隧道实测瞬断后
        # 池里残留 [BAD] 连接不自愈,曾致 finish_run 写终态失败、run 卡 running);max_lifetime 定期换血。
        _pool = ConnectionPool(
            conninfo=settings.database_url, min_size=1, max_size=max_size, open=False,
            check=ConnectionPool.check_connection, max_lifetime=1800, reconnect_timeout=10,
        )
        _pool.open()
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def ping() -> bool:
    try:
        with get_pool().connection() as conn:
            conn.execute("select 1")
        return True
    except Exception:
        logger.warning("db ping failed", exc_info=True)  # 记因由，别把配置错当临时不可达
        return False
