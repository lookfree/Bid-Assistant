"""标书分类判定（spec334）：读标收尾 / 审查开头的一次轻量结构化调用。

三条设计约束（改动前请先读）：
1. **不进 submit_read_result 的工具 schema**——分类是另一次调用的产物，挂进读标那个大 schema
   等于让它被小模型静默跳过。落地沿用 doc_sections 的成例：并进结果 dict。
2. **只喂摘要不喂全文**——读标本身是并行多路、百万字量级的调用，分类几 k tokens 可忽略。
3. **任何失败一律吞掉，返回空分类**——读标与审查是链上最贵的步，绝不能为一次锦上添花的分类
   赔上整轮费用。判不出就交给用户在页面上选。
"""
from __future__ import annotations

import json
import logging

from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.prompts.classify import CLASSIFY_SYSTEM_PROMPT
from agent.agents.bidding_agent.schemas import BidCategory

logger = logging.getLogger(__name__)

EMPTY: dict = {"value": [], "confidence": "low", "reason": "", "evidence_clause_ids": []}

_MAX_ITEMS = 25          # 每类最多喂多少条读标条目
_MAX_CHAPTERS = 20       # 自查模式最多喂多少章
_CHAPTER_HEAD = 200      # 每章取前多少字


def _read_summary(read: dict) -> tuple[str, set[str]]:
    """读标结论 → 分类摘要 + 允许引用的条款 id 集合。
    只取「能看出采购标的是什么」的部分：项目信息、技术需求与资格条款、评分类目、构成清单标题。"""
    ids: set[str] = set()
    cats: list[dict] = []
    for c in read.get("categories") or []:
        if c.get("key") not in ("overview", "technical", "qualification", "commercial"):
            continue
        items = []
        for it in (c.get("items") or [])[:_MAX_ITEMS]:
            cid = (it.get("clause_ids") or [None])[0]
            if cid:
                ids.add(cid)
            items.append({"title": it.get("title", ""), "value": (it.get("value") or "")[:60],
                          "clause_id": cid})
        if items:
            cats.append({"分类": c.get("title", c.get("key")), "条目": items})
    payload = {
        "项目信息": read.get("project_meta") or {},
        "关键条款": cats,
        "评分类目": sorted({s.get("category", "") for s in (read.get("scoring") or []) if s.get("category")}),
        "投标文件构成": [s.get("title", "") for s in (read.get("required_structure") or [])][:_MAX_ITEMS],
    }
    return json.dumps(payload, ensure_ascii=False), ids


def _chapters_summary(chapters: dict[str, str]) -> tuple[str, set[str]]:
    """上传标书正文 → 分类摘要。自查模式（未提供招标文件）用：章节标题 + 每章开头若干字。
    正文是 HTML，粗暴去标签即可——分类只看词面，不需要结构。"""
    import re

    rows = []
    for cid, html in list(chapters.items())[:_MAX_CHAPTERS]:
        text = re.sub(r"<[^>]+>", " ", html or "")
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            rows.append({"章id": cid, "开头": text[:_CHAPTER_HEAD]})
    return json.dumps({"投标文件章节": rows}, ensure_ascii=False), set()


async def _classify(ctx, summary: str, allowed_ids: set[str], what: str) -> dict:
    """跑一次分类调用。**任何异常都吞掉**并返回空分类——调用方是读标/审查节点，不能被拖垮。"""
    user = f"{what}：\n{summary}\n请判断本次采购属于货物类、服务类还是工程类。"
    try:
        result: BidCategory = await run_submit_agent(
            ctx, CLASSIFY_SYSTEM_PROMPT, user,
            "submit_bid_category", BidCategory, "提交标书分类", attempts=2)
    except Exception:  # noqa: BLE001 分类是加法，失败只记日志，绝不影响所在步
        logger.warning("标书分类判定失败，按未判定处理", exc_info=True)
        return dict(EMPTY)
    out = result.model_dump()
    # 证据条款 id 必须真实存在：模型编造的 id 前端点开定位不到，是比没有证据更糟的体验
    out["evidence_clause_ids"] = [i for i in out["evidence_clause_ids"] if i in allowed_ids][:5]
    return out


async def classify_from_read(ctx, read: dict) -> dict:
    """读标结论 → 分类。**多包件招标一律不判**：判定发生在用户选包之前，各包可能分属不同类别，
    拿全文判出来安到某个具体包上是错的（选包入口在读标页，晚于本调用）。"""
    if len(read.get("packages") or []) > 1:
        return dict(EMPTY)
    summary, ids = _read_summary(read)
    return await _classify(ctx, summary, ids, "读标结论摘要")


async def classify_from_chapters(ctx, chapters: dict[str, str]) -> dict:
    """上传标书正文 → 分类（自查模式，没有招标文件可读）。"""
    if not chapters:
        return dict(EMPTY)
    summary, ids = _chapters_summary(chapters)
    return await _classify(ctx, summary, ids, "投标文件正文摘要")
