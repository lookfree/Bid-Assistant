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
        # maxlen 截断最老事件:92 块并行读标每 4s×6 路心跳可累积数千帧,订阅端从 0 回放会先啃完
        # 全部陈旧"生成中"帧才见新事件。run.end 由 executor 直发(不走此函数),永不会被截掉。
        await asyncio.to_thread(redis.xadd, progress_stream(run_id),
                                {"event": json.dumps(ev, ensure_ascii=False)},
                                maxlen=1000, approximate=True)
    except Exception:  # noqa: BLE001 进度推送 best-effort
        logger.warning("progress publish failed", exc_info=True)


async def publish_phase(ctx: Any, label: str, done: int | None = None,
                        total: int | None = None) -> None:
    """推一条 phase 阶段事件（读标分段/各步阶段名），前端订阅后实时显示「跑到哪一步」。

    给了 done/total 就一并结构化推出去，前端据此画进度条；不给就只有文案。
    **数字必须走字段，不许让前端去正则解析中文文案**——文案是给人看的，改一个字
    （加个「(续跑复用 2)」后缀之类）就会把解析打歪，而那种打歪是静默的。
    total 为 0/None 时只发文案：除以零画不出百分比，宁可退回纯文字。"""
    ev: dict[str, Any] = {"kind": "phase", "label": label}
    if done is not None and total:
        ev["done"], ev["total"] = done, total
    await publish_event(getattr(ctx, "redis", None), getattr(ctx, "run_id", None), ev)
