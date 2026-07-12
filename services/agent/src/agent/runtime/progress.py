from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from agent.runtime.channels import progress_stream

logger = logging.getLogger(__name__)


async def publish_event(redis: Any, run_id: str | None, data: dict) -> None:
    """向进度流推一条事件（best-effort）：data 形如 {"kind":"phase","label":...} /
    {"kind":"chapter",...} / {"kind":"heartbeat",...}。无 redis/run_id 或推送失败都静默，绝不影响主流程。"""
    try:
        if not redis or not run_id:
            return
        ev = {"type": "progress", "data": data}
        await asyncio.to_thread(redis.xadd, progress_stream(run_id), {"event": json.dumps(ev, ensure_ascii=False)})
    except Exception:  # noqa: BLE001 进度推送 best-effort
        logger.warning("progress publish failed", exc_info=True)


async def publish_phase(ctx: Any, label: str) -> None:
    """推一条 phase 阶段事件（读标分段/各步阶段名），前端订阅后实时显示「跑到哪一步」。"""
    await publish_event(getattr(ctx, "redis", None), getattr(ctx, "run_id", None),
                        {"kind": "phase", "label": label})
