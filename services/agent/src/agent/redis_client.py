import redis
from agent.config import settings

_client = redis.Redis(
    host=settings.redis_host,
    port=settings.redis_port,
    password=settings.redis_password,
    db=settings.redis_db,
    decode_responses=True,
)


def get_redis() -> redis.Redis:
    return _client


def ping() -> bool:
    try:
        return bool(_client.ping())
    except Exception:
        return False
