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
