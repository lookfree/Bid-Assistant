from contextlib import asynccontextmanager

from fastapi import FastAPI

from agent import db, redis_client
from agent.routes.health import router as health_router
from agent.routes.runs import router as runs_router
from agent.routes.chapters import router as chapters_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动预热连接池；关闭时优雅释放（对齐 apps/api 的 closeDb/closeRedis 接 SIGINT）。
    db.get_pool()
    yield
    db.close_pool()
    redis_client.close_redis()


def create_app() -> FastAPI:
    app = FastAPI(title="bid-agent", lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(runs_router)
    app.include_router(chapters_router)
    return app
