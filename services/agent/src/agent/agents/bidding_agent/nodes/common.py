from __future__ import annotations

import asyncio
import json
import logging

from agent.parsing import storage_read
from agent.parsing.storage_read import storage      # spec106 MinIO 单例
from agent.runtime.channels import progress_stream

logger = logging.getLogger(__name__)


async def publish_phase(ctx, label: str) -> None:
    """向进度流推一条 phase 事件（读标分段/各步阶段名），前端订阅后实时显示「跑到哪一步」。
    best-effort:无 redis/run_id 或推送失败都静默,绝不影响主流程。"""
    try:
        r = getattr(ctx, "redis", None)
        rid = getattr(ctx, "run_id", None)
        if not r or not rid:
            return
        ev = {"type": "progress", "data": {"kind": "phase", "label": label}}
        await asyncio.to_thread(r.xadd, progress_stream(rid), {"event": json.dumps(ev, ensure_ascii=False)})
    except Exception:  # noqa: BLE001 进度推送 best-effort
        logger.warning("publish_phase failed", exc_info=True)


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


def _pkg_id(run_input: dict | None) -> str | None:
    return ((run_input or {}).get("package") or {}).get("id") or None


def filter_read_by_package(read: dict, run_input: dict | None) -> dict:
    """选包时把读标结论收窄到该包(spec324 上下文优化):保留 packages 为空(全包通用)或含所选包 id 的条目,
    别的包专属条目丢弃——喂给 LLM 的上下文从「全部包」缩到「单包」,大标书速度/成本降 2-3 倍。
    未选包(单包/缺省) → 原样返回,行为逐字节不变。categories.items / scoring / required_structure 三处过滤。"""
    pid = _pkg_id(run_input)
    if not pid:
        return read

    def keep(it: dict) -> bool:
        pk = it.get("packages") or []
        return not pk or pid in pk

    out = dict(read)
    out["categories"] = [{**c, "items": [i for i in c.get("items", []) if keep(i)]}
                         for c in read.get("categories", [])]
    out["scoring"] = [s for s in read.get("scoring", []) if keep(s)]
    if "required_structure" in read:
        out["required_structure"] = [s for s in read.get("required_structure", []) if keep(s)]
    return out


def slim_read(read: dict) -> dict:
    """白名单出下游提示词需要的读标字段（项目信息/分类/评分表/红线），
    并裁掉 source_quote（原文摘录，token 大头）。outline / review 共用。"""
    cats = [{**c, "items": [{k: v for k, v in it.items() if k != "source_quote"}
                            for it in c.get("items", [])]}
            for c in read.get("categories", [])]
    return {"project_meta": read.get("project_meta", {}), "categories": cats,
            "scoring": read.get("scoring", []), "risk_summary": read.get("risk_summary", [])}
