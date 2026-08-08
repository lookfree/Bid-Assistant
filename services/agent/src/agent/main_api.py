import uvicorn
from agent.app import create_app
from agent.config import settings
from agent.main_worker import _setup_logging

# 与 worker 同一套：应用日志接到 stdout，否则 logger.warning 那些降级/超时决策一条都看不到
# （2026-08-08 查一次正文失败时，容器日志里只有启动那几行）。改写走的是本进程。
_setup_logging()

app = create_app()

if __name__ == "__main__":
    uvicorn.run("agent.main_api:app", host="0.0.0.0", port=settings.port, reload=True)
