FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY services/agent/pyproject.toml services/agent/.python-version services/agent/uv.lock ./
RUN uv sync --no-dev --no-install-project
COPY services/agent/src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8090
# 默认 api 角色；worker 角色覆盖 CMD: uv run python -m agent.main_worker
CMD ["uv", "run", "uvicorn", "agent.main_api:app", "--host", "0.0.0.0", "--port", "8090"]
