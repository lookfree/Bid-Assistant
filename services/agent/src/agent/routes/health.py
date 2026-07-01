from fastapi import APIRouter
from fastapi.responses import JSONResponse
from agent import db, redis_client

router = APIRouter()


@router.get("/healthz")
async def healthz():
    return {"status": "ok"}


@router.get("/readyz")
async def readyz():
    pg = db.ping()
    rds = redis_client.ping()
    ok = pg and rds
    return JSONResponse(
        {"status": "ready" if ok else "unready", "pg": "up" if pg else "down", "redis": "up" if rds else "down"},
        status_code=200 if ok else 503,
    )
