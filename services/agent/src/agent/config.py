from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 从本文件向上找仓库根的 .env.bidsaas.local（不依赖进程 CWD，也不硬编码目录层数——
# 容器里源码在 /app/src/agent，层数比主机浅）。找不到就返回 None，pydantic-settings
# 改从进程环境变量读（Docker 由 compose 注入 env）。
def _find_env_file() -> str | None:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / ".env.bidsaas.local"
        if candidate.exists():
            return str(candidate)
    return None


_ENV_FILE = _find_env_file()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,  # 复用仓库根中间件密钥；None 时改读进程环境变量
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: str = "development"
    port: int = 8090

    database_url: str  # 来自 DATABASE_URL（bidsaas）
    redis_host: str = "127.0.0.1"
    redis_port: int = 6379
    redis_password: str | None = None
    redis_db: int = 3
    redis_prefix: str = "bid:agent:"  # 智能体服务自有命名空间（区别于 App 的 bid:）

    # Worker 并发执行的 run 上限（不同标书并发，spec317）
    agent_worker_concurrency: int = 5

    # 孤儿 run 清道夫（spec318）：心跳存活窗口 + queued 判丢阈值
    run_heartbeat_ttl_s: int = 120   # run:hb:<run_id> 的 EX；worker 每次发布事件续期
    queued_stale_s: int = 600        # queued 状态超过此时长且 stream 侧无对应 pending 条目 = 判丢

    # 模型 Key（OpenAI 兼容；凭据就绪时填，当前可能缺失）
    deepseek_api_key: str | None = None
    dashscope_api_key: str | None = None      # 通义千问（DashScope）
    zhipu_api_key: str | None = None           # 智谱 GLM
    # 默认与回退链
    model_default_provider: str = "deepseek"
    model_default_model: str | None = None     # None 则用 provider 默认模型
    model_fallbacks: str = ""                   # "qwen:qwen-plus,glm:glm-4-flash"
    model_temperature: float | None = None     # None=用 provider 默认；由 App run override 下发
    model_max_tokens: int | None = None
    model_top_p: float | None = None
    # 流式空闲超时（大标书读标实测：单块生成慢而健康达数分钟，"总超时"会误杀——只在"连续无 token"时判挂死）。
    model_idle_timeout_s: int = 30              # 流式中连续 N 秒无新 token = 连接挂死 → 降级重试
    model_first_token_timeout_s: int = 120      # 首 token（含连接+大 prompt 预填）宽限，避免误杀慢启动
    # 结构化模型链（spec319.1）：每项 {provider, model, base_url, api_key}；仅由 App run override
    # 经 model_copy(update=...) 注入，不从 env 解析（pydantic-settings 对 list[dict] 复杂字段不读 env）。
    model_chain: list[dict] | None = None

    app_callback_url: str | None = None         # App 的用量回调端点；None 则跳过（dummy/dev）

    # MinIO（招标文件按 key 读取；凭据从 env）
    minio_endpoint: str | None = None           # 来自 MINIO_ENDPOINT
    minio_access_key: str | None = None
    minio_secret_key: str | None = None
    minio_bucket: str = "bidsaas"
    minio_region: str = "us-east-1"

    # 资料库 RAG（spec316）：自建 bge-embed，OpenAI 兼容 /v1/embeddings，dense 1024 维
    rag_embed_endpoint: str = "http://host.docker.internal:18080/v1/embeddings"


settings = Settings()  # 实例化即校验
