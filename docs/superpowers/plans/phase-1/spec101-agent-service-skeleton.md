# spec101 · Agent Service 骨架（Python + FastAPI） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `services/agent` 建立 Python + FastAPI 智能体服务骨架：uv 项目、Pydantic 配置、`/healthz` 存活、`/readyz` 依赖探针（连 bidsaas 的 PG `langgraph` schema + Redis），并搭好 **api / worker 双角色**入口脚手架（§4.6），为 spec102/103 填充。

**Architecture:** 单代码库两入口——`api`（uvicorn 起 FastAPI，建 run / SSE）与 `worker`（消费队列跑图，spec103 填充）；共享 config / db / redis 客户端。配置经 `pydantic-settings` 读仓库根 `.env.bidsaas.local`（复用 Phase 0 中间件密钥）。

**Tech Stack:** Python 3.12、uv、FastAPI、uvicorn、pydantic-settings、psycopg(3)、redis-py、pytest。

## Global Constraints

见 `spec100-index.md`。本 spec 关键约束：
- 服务对业务无知（§3.2）；只搭骨架，不含业务/计费。
- 复用 bidsaas：PG `langgraph` schema（checkpointer 用，Phase 0 已建）、Redis（前缀 `bid:agent:`）。
- 配置 env_file = 仓库根 `.env.bidsaas.local`（已含 `DATABASE_URL/REDIS_*/MINIO_*`，不入库）。
- 在 `main` 上先开分支；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
services/agent/
├── pyproject.toml                  # 新：uv 项目 + 依赖
├── .python-version                 # 新：3.12
├── src/agent/
│   ├── __init__.py
│   ├── config.py                   # 新：Settings(pydantic-settings)
│   ├── app.py                      # 新：create_app() -> FastAPI（挂 health 路由）
│   ├── routes/health.py            # 新：/healthz、/readyz
│   ├── db.py                       # 新：psycopg 连接池 + ping
│   ├── redis_client.py             # 新：redis-py 客户端
│   ├── main_api.py                 # 新：api 角色入口（uvicorn 目标）
│   └── main_worker.py              # 新：worker 角色入口脚手架
├── tests/
│   ├── test_health.py              # 新：/healthz（无依赖）
│   └── test_readyz.py              # 新：/readyz（真 PG/Redis）
└── Dockerfile                      # 新：oven 无关，python:3.12-slim + uv
```

---

## Interfaces（本 spec 对外产出，供 spec102/103 依赖）

- Produces：
  - `create_app() -> FastAPI`（spec103 在其上挂 `/agents`、`/runs` 路由）。
  - `settings`（`Settings`）：`database_url`、`redis_host/redis_port/redis_password/redis_db`、`redis_prefix`、`port`、`env`（model keys 在 spec102 追加）。
  - `db.ping() -> bool`、`db.pool`（psycopg 连接池）。
  - `get_redis() -> redis.Redis`（带前缀约定）。
  - 入口：`agent.main_api`（api 角色）、`agent.main_worker`（worker 角色）。

---

## Task 1: uv 项目 + FastAPI + /healthz + 配置

**Files:**
- Create: `services/agent/pyproject.toml`、`.python-version`、`src/agent/__init__.py`、`config.py`、`app.py`、`routes/health.py`、`main_api.py`、`tests/test_health.py`

- [ ] **Step 1: 开分支 + 建 uv 项目**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec101-agent-skeleton
mkdir -p services/agent/src/agent/routes services/agent/tests
cd services/agent
echo "3.12" > .python-version
```

- [ ] **Step 2: 写 `services/agent/pyproject.toml`**

```toml
[project]
name = "bid-agent"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.32",
  "pydantic-settings>=2.5",
  "psycopg[binary,pool]>=3.2",
  "redis>=5.1",
  "httpx>=0.27",
]

[dependency-groups]
dev = ["pytest>=8.3", "pytest-asyncio>=0.24", "ruff>=0.7"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
pythonpath = ["src"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

- [ ] **Step 3: 写 `src/agent/config.py`**

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../../.env.bidsaas.local",  # 复用仓库根中间件密钥
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
```

> 注：env_file 路径相对于**进程工作目录**；约定从 `services/agent/` 运行（uv/pytest）。`DATABASE_URL` 等大小写不敏感映射到字段。

- [ ] **Step 4: 写 `src/agent/routes/health.py`**

```python
from fastapi import APIRouter

router = APIRouter()


@router.get("/healthz")
async def healthz():
    return {"status": "ok"}
```

- [ ] **Step 5: 写 `src/agent/app.py`**

```python
from fastapi import FastAPI
from agent.routes.health import router as health_router


def create_app() -> FastAPI:
    app = FastAPI(title="bid-agent")
    app.include_router(health_router)
    return app
```

- [ ] **Step 6: 写 `src/agent/main_api.py`**

```python
import uvicorn
from agent.app import create_app
from agent.config import settings

app = create_app()

if __name__ == "__main__":
    uvicorn.run("agent.main_api:app", host="0.0.0.0", port=settings.port, reload=True)
```

- [ ] **Step 7: 写 `src/agent/__init__.py`（空）与失败测试 `tests/test_health.py`**

```python
from fastapi.testclient import TestClient
from agent.app import create_app


def test_healthz():
    client = TestClient(create_app())
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
```

- [ ] **Step 8: 安装 + 跑测试**

Run: `cd services/agent && uv sync && uv run pytest tests/test_health.py -q`
Expected: 1 passed（`/healthz` 200）。

- [ ] **Step 9: 提交**

```bash
git add services/agent
git commit -m "feat(spec101): agent 服务 uv 项目 + FastAPI + /healthz + 配置

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: PG + Redis 客户端 + /readyz（连真 bidsaas）

**Files:**
- Create: `src/agent/db.py`、`src/agent/redis_client.py`、`tests/test_readyz.py`
- Modify: `src/agent/routes/health.py`、`src/agent/app.py`

- [ ] **Step 1: 写 `src/agent/db.py`**

```python
import psycopg
from psycopg_pool import ConnectionPool
from agent.config import settings

pool = ConnectionPool(conninfo=settings.database_url, min_size=1, max_size=10, open=True)


def ping() -> bool:
    try:
        with pool.connection() as conn:
            conn.execute("select 1")
        return True
    except Exception:
        return False
```

- [ ] **Step 2: 写 `src/agent/redis_client.py`**

```python
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
```

- [ ] **Step 3: 在 `routes/health.py` 加 /readyz**

```python
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
```

- [ ] **Step 4: 写 `tests/test_readyz.py`（真依赖）**

```python
from fastapi.testclient import TestClient
from agent.app import create_app


def test_readyz_ok():
    client = TestClient(create_app())
    res = client.get("/readyz")
    assert res.status_code == 200
    body = res.json()
    assert body["pg"] == "up"
    assert body["redis"] == "up"
```

- [ ] **Step 5: 运行（连 bidsaas）**

Run: `cd services/agent && uv run pytest tests/test_readyz.py -q`
Expected: 1 passed（PG/Redis 均 up）。

- [ ] **Step 6: 提交**

```bash
git add services/agent
git commit -m "feat(spec101): PG/Redis 客户端 + /readyz 依赖探针(连 bidsaas)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: worker 角色脚手架 + Dockerfile + 合并

**Files:**
- Create: `src/agent/main_worker.py`、`services/agent/Dockerfile`

- [ ] **Step 1: 写 `src/agent/main_worker.py`（脚手架，spec103 填消费逻辑）**

```python
"""Worker 角色入口：消费队列、跑图、回传进度（spec103 实现）。
本 spec 仅建立可启动的骨架：连通依赖后等待。"""
import time
from agent.config import settings
from agent import db, redis_client


def main() -> None:
    assert db.ping(), "PG 不可达"
    assert redis_client.ping(), "Redis 不可达"
    print(f"[worker] up, env={settings.env}, prefix={settings.redis_prefix} (消费逻辑见 spec103)")
    # spec103：从 Redis Stream 消费 run 任务并执行
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 写 `services/agent/Dockerfile`**

```dockerfile
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY services/agent/pyproject.toml services/agent/.python-version ./
RUN uv sync --no-dev --no-install-project
COPY services/agent/src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8090
# 默认 api 角色；worker 角色覆盖 CMD: uv run python -m agent.main_worker
CMD ["uv", "run", "uvicorn", "agent.main_api:app", "--host", "0.0.0.0", "--port", "8090"]
```

> 构建上下文为仓库根（与 Phase 0 Dockerfile 一致）；env 由容器注入（compose 用外部中间件地址）。

- [ ] **Step 3: 本地起 worker 冒烟**

Run: `cd services/agent && uv run python -m agent.main_worker`
Expected: 打印 `[worker] up ...`（连通 PG/Redis 后挂起），Ctrl-C 退出。

- [ ] **Step 4: 全量测试 + lint + 合并**

Run: `cd services/agent && uv run pytest -q && uv run ruff check src`
Expected: 全 passed，ruff 无错。

```bash
git add services/agent/src/agent/main_worker.py services/agent/Dockerfile
git commit -m "feat(spec101): worker 角色脚手架 + Dockerfile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase1/spec101-agent-skeleton -m "merge spec101: Agent Service 骨架"
git push origin main
```

---

## 验收清单（spec101 完成判据）

- [ ] `uv sync` 成功；`uv run pytest` 全过（/healthz 无依赖、/readyz 连真 bidsaas）。
- [ ] `/healthz` 200 `{status:ok}`；`/readyz` 200 `{status:ready,pg:up,redis:up}`。
- [ ] `agent.main_api`（api 角色）与 `agent.main_worker`（worker 角色脚手架）均可启动并连通中间件。
- [ ] 配置从根 `.env.bidsaas.local` 读，密钥不入库。
- [ ] Dockerfile 可构建（python:3.12-slim + uv）。
- [ ] 服务对业务无知，仅骨架（无计费/业务）。
