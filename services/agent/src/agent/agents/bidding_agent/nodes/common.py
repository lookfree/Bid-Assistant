from __future__ import annotations

import asyncio
import logging

from agent.parsing import storage_read
from agent.parsing.storage_read import storage      # spec106 MinIO 单例

logger = logging.getLogger(__name__)


async def upload_artifact(ctx, filename: str, data: bytes, content_type: str) -> str:
    """终产物统一落 MinIO：artifacts/<thread_id>/<filename>，返回 key。present/export 共用。"""
    key = f"artifacts/{ctx.thread_id}/{filename}"
    await storage.put_bytes(key, data, content_type=content_type)
    return key


async def fetch_master_bytes(key: str | None) -> bytes | None:
    """企业自有 .pptx/.potx 母版按 MinIO key 预取字节；present（首渲）/export（重渲）共用。
    缺 key 或取失败（网络抖动/坏 key/未上传）→ 记警告日志并回 None——render_pptx 自身在母版
    加载/渲染失败时也会回退空白设计，这里再兜一层，双保险不阻断述标/导出产出。"""
    if not key:
        return None
    try:
        return await asyncio.to_thread(storage_read.read_bytes, key)
    except Exception:
        logger.warning("企业母版拉取失败 key=%s", key, exc_info=True)
        return None


def package_scope(run_input: dict | None) -> str:
    """run_input.package 存在时的范围约束文本（spec324）：outline/content 共用，追加在用户
    消息末尾；未选包（缺省）时返回空串，用户消息与此前逐字节一致。"""
    package = (run_input or {}).get("package") or {}
    if not package:
        return ""
    name = package.get("name", "")
    pid = package.get("id", "")
    return (f"\n本项目仅投包件《{name}》({pid})：提纲/正文仅覆盖该包件的需求、评分与构成，"
            "其它包件内容一律忽略；涉及分包件评分表/偏离表仅取该包件。")


def slim_read(read: dict) -> dict:
    """白名单出下游提示词需要的读标字段（项目信息/分类/评分表/红线），
    并裁掉 source_quote（原文摘录，token 大头）。outline / review 共用。"""
    cats = [{**c, "items": [{k: v for k, v in it.items() if k != "source_quote"}
                            for it in c.get("items", [])]}
            for c in read.get("categories", [])]
    return {"project_meta": read.get("project_meta", {}), "categories": cats,
            "scoring": read.get("scoring", []), "risk_summary": read.get("risk_summary", [])}
