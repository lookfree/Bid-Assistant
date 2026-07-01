from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../../.env.bidsaas.local",  # 复用仓库根中间件密钥（相对进程工作目录 services/agent/）
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
    redis_prefix: str = "bid:agent:"


settings = Settings()  # 实例化即校验
