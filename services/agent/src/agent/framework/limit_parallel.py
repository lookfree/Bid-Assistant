"""限制同时在写的子写手数量（deepagents 的 task 派发闸）。

2026-08-08 生产实测：规划者把剩下的 15 章**一波全派**，15 路子写手同时打自建端点，
每路带约 5 万 token 的预填充——端点吞吐被挤满，谁都吐不出字，横幅停在"3/20 章"几分钟不动，
用户以为挂了。此前端点反复"掉线"多半也有这份功劳：不是它死了，是被我们自己打满了。

闸加在 **task 工具的执行层**（awrap_tool_call）：超出上限的派发排队等位，
而不是全部同时冲向端点。排队中的不算"在写"（回调在 handler 里才触发），
横幅的并发数因此如实显示的是真正在写的路数。上限走配置（MODEL_CONTENT_MAX_PARALLEL），
按端点容量调，不用改代码。
"""
from __future__ import annotations

import asyncio
import logging

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest

from agent.config import settings

logger = logging.getLogger(__name__)


class LimitParallelWritersMiddleware(AgentMiddleware):
    """每个实例＝一次正文任务：信号量按 run 独立，不跨任务共享。"""

    def __init__(self, max_parallel: int | None = None) -> None:
        super().__init__()
        n = max_parallel or getattr(settings, "model_content_max_parallel", 5)
        self._sem = asyncio.Semaphore(max(1, int(n)))
        self._limit = n

    async def awrap_tool_call(self, request: ToolCallRequest, handler):
        if ((request.tool_call or {}).get("name")) != "task":
            return await handler(request)    # 只闸派发；读写文件等轻工具不排队
        if self._sem.locked():
            logger.info("子写手并发已达上限 %s，本次派发排队等位", self._limit)
        async with self._sem:
            return await handler(request)
