from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 仓库根的 .env.bidsaas.local，按本文件位置定位（不依赖进程 CWD，从任何目录/容器都稳）。
# 缺失时 pydantic-settings 会忽略该文件，改从进程环境变量读（Docker 由 compose 注入 env）。
_ENV_FILE = Path(__file__).resolve().parents[4] / ".env.bidsaas.local"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),  # 复用仓库根中间件密钥
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


settings = Settings()  # 实例化即校验
