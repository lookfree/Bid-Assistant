from agent.config import settings

# redis-py 无内建 keyPrefix，这里显式拼 settings.redis_prefix（bid:agent:）。


def stream_key() -> str:
    return f"{settings.redis_prefix}runs"                       # Redis Stream：待执行 run


def progress_stream(run_id: str) -> str:
    return f"{settings.redis_prefix}run:{run_id}"               # Redis Stream：进度事件（可回放）


def runmeta_key(run_id: str) -> str:
    return f"{settings.redis_prefix}runmeta:{run_id}"


def result_key(run_id: str) -> str:
    return f"{settings.redis_prefix}result:{run_id}"
