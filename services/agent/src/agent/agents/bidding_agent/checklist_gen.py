"""定制审核表生成（spec333）：读已存的读标结论 → 一次结构化 LLM 调用 → 产投递前审核表。
无状态、不进 thread、不涉计费（计费归属读标步，App 层 best-effort 调用）。与 outline 节点同范式。"""
from __future__ import annotations

import json

from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.schemas import ChecklistGen
from agent.agents.bidding_agent.prompts.checklist import CHECKLIST_GEN_SYSTEM_PROMPT


def _slim_for_checklist(read: dict) -> dict:
    """白名单出审核表所需读标字段并裁掉 token 大头（source_quote）。
    比 slim_read 多带 required_structure（份数/密封/签章/递交是审核表关键），少带评分明细（只留★项名）。"""
    cats = [{"title": c.get("title"),
             "items": [{k: v for k, v in it.items() if k not in ("source_quote", "clause_ids", "packages")}
                       for it in c.get("items", [])]}
            for c in read.get("categories", [])]
    structure = [{"title": s.get("title"), "required": s.get("required", True),
                  "kind": s.get("kind"), "notes": s.get("notes", "")}
                 for s in read.get("required_structure", [])]
    scoring_stars = [s.get("name") for s in read.get("scoring", []) if s.get("star")]
    return {"project_meta": read.get("project_meta", {}), "categories": cats,
            "risk_summary": read.get("risk_summary", []), "required_structure": structure,
            "scoring_star_items": scoring_stars}


async def generate_checklist(ctx, read_result: dict) -> ChecklistGen:
    """ctx.gateway 一次结构化提交产 ChecklistGen；模型未提交则 run_submit_agent 抛错（App 层回落默认 36）。"""
    slim = json.dumps(_slim_for_checklist(read_result or {}), ensure_ascii=False)
    user = f"读标结论：\n{slim}\n请据此产出投递前终极审核表。"
    return await run_submit_agent(
        ctx, CHECKLIST_GEN_SYSTEM_PROMPT, user,
        "submit_checklist", ChecklistGen, "提交审核表")
