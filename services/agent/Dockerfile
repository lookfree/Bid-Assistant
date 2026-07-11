FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
# spec320：.doc/.xls 旧格式经 LibreOffice headless 转 docx/xlsx 后再解析
# fonts-noto-cjk：服务端 docx/pptx→PDF 转换必需——无 CJK 字体时中文全部渲染成豆腐块（e2e 实测）
# python3-uno：给系统 python3 提供 uno 绑定（Debian 打包已配好 URE_BOOTSTRAP 等环境变量），
# render/pdf.py 用它跑 UNO 脚本更新 PDF 目录域——纯 CLI --convert-to 不会刷新目录（e2e 实测）
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-cjk python3-uno && rm -rf /var/lib/apt/lists/*
COPY services/agent/pyproject.toml services/agent/.python-version services/agent/uv.lock ./
RUN uv sync --no-dev --no-install-project
COPY services/agent/src ./src
ENV PYTHONPATH=/app/src
EXPOSE 8090
# 默认 api 角色；worker 角色覆盖 CMD: uv run python -m agent.main_worker
CMD ["uv", "run", "uvicorn", "agent.main_api:app", "--host", "0.0.0.0", "--port", "8090"]
