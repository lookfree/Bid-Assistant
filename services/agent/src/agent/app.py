from fastapi import FastAPI
from agent.routes.health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(title="bid-agent")
    app.include_router(health_router)
    return app
