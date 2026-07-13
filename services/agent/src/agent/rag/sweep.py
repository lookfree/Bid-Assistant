"""tender chunks 每日清扫——项目向量超期即死数据,不清理表会随历史项目无限膨胀。"""
from __future__ import annotations

import asyncio
import logging

from agent.config import settings
from agent.db import get_pool
from agent.rag import store

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_S = 24 * 3600


async def sweep_once() -> int:
    """分批清扫到删净（同步 DELETE 丢线程池，不卡 event loop）。批间是 await 点：
    发版关停时 cancel 最多等一批（to_thread 里的语句本身不可取消，无界单删会卡优雅停机）。
    返回总删除行数。"""
    total = 0
    while True:
        n = await asyncio.to_thread(
            store.sweep_expired_tender, get_pool(), settings.rag_tender_ttl_days
        )
        total += n
        if n < store.SWEEP_BATCH_LIMIT:  # 不足一批 = 已删净
            return total


async def sweep_loop() -> None:
    """启动即扫一次，之后每 24h 一次；单次失败只记日志，循环不退出。"""
    while True:
        try:
            n = await sweep_once()
            logger.info("rag tender sweep removed %d expired chunks (ttl=%dd)",
                        n, settings.rag_tender_ttl_days)
        except Exception:  # noqa: BLE001 清扫是后台兜底，任何故障都不该影响服务
            logger.warning("rag tender sweep failed", exc_info=True)
        await asyncio.sleep(SWEEP_INTERVAL_S)
