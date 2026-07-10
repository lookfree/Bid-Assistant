from contextlib import asynccontextmanager

from fastapi import FastAPI

from agent import db, redis_client
from agent.routes.health import router as health_router
from agent.routes.runs import router as runs_router
from agent.routes.chapters import router as chapters_router
from agent.routes.dedupe import router as dedupe_router
from agent.routes.checklist import router as checklist_router
from agent.routes.models import router as models_router


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
    app.include_router(dedupe_router)      # spec315b 查重（同步、无 thread）
    app.include_router(checklist_router)   # spec315b 审核表渲染（同步无状态）
    app.include_router(models_router)      # spec319 模型连通性测试探针
    return app
