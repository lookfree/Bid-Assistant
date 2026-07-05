import logging

import redis

from agent.config import settings

logger = logging.getLogger(__name__)

# 惰性单例（import 无副作用，对齐 apps/api 的 getRedis）。redis-py 本身首次命令才连。
_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password,
            db=settings.redis_db,
            decode_responses=True,
            # 阻塞读（worker xread block=5000 / agent-api stream block=1000）必须给 socket_timeout > block：
            # WAN 上无 deadline 的纯阻塞 socket 会被中间件静默掐断，redis-py 干等到 TCP 超时（实测 ~63s）才报
            # "Timeout reading from socket"。socket_timeout=10s 让阻塞读到点正常返回；keepalive 探活死连接。
            socket_timeout=10,
            socket_keepalive=True,
        )
    return _client


def close_redis() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


def ping() -> bool:
    try:
        return bool(get_redis().ping())
    except Exception:
        logger.warning("redis ping failed", exc_info=True)
        return False
