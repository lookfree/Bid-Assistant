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

    # 模型 Key（OpenAI 兼容；凭据就绪时填，当前可能缺失）
    deepseek_api_key: str | None = None
    dashscope_api_key: str | None = None      # 通义千问（DashScope）
    zhipu_api_key: str | None = None           # 智谱 GLM
    # 默认与回退链
    model_default_provider: str = "deepseek"
    model_default_model: str | None = None     # None 则用 provider 默认模型
    model_fallbacks: str = ""                   # "qwen:qwen-plus,glm:glm-4-flash"

    app_callback_url: str | None = None         # App 的用量回调端点；None 则跳过（dummy/dev）


settings = Settings()  # 实例化即校验
