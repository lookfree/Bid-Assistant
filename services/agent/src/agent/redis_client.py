import logging

import redis
from redis.backoff import ExponentialBackoff
from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
from redis.retry import Retry

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
            socket_connect_timeout=10,
            # 抗网络抖动(WAN 隧道实测瞬断):坏连接自动重连+重试短暂失败,而非把错误直接抛给调用方
            # (曾致 create_run 的 runmeta 写失败/命令读到坏连接连环报错)。health_check 定期探活淘汰死连接。
            retry=Retry(ExponentialBackoff(base=0.1, cap=2), retries=3),
            retry_on_error=[RedisConnectionError, RedisTimeoutError],
            health_check_interval=30,
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
