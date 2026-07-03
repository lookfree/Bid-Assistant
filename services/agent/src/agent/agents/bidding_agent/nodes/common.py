from __future__ import annotations

from agent.parsing.storage_read import storage      # spec106 MinIO 单例


async def upload_artifact(ctx, filename: str, data: bytes, content_type: str) -> str:
    """终产物统一落 MinIO：artifacts/<thread_id>/<filename>，返回 key。present/export 共用。"""
    key = f"artifacts/{ctx.thread_id}/{filename}"
    await storage.put_bytes(key, data, content_type=content_type)
    return key


def slim_read(read: dict) -> dict:
    """白名单出下游提示词需要的读标字段（项目信息/分类/评分表/红线），
    并裁掉 source_quote（原文摘录，token 大头）。outline / review 共用。"""
    cats = [{**c, "items": [{k: v for k, v in it.items() if k != "source_quote"}
                            for it in c.get("items", [])]}
            for c in read.get("categories", [])]
    return {"project_meta": read.get("project_meta", {}), "categories": cats,
            "scoring": read.get("scoring", []), "risk_summary": read.get("risk_summary", [])}
