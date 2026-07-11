from __future__ import annotations
import json
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import slim_read
from agent.agents.bidding_agent.schemas import RiskReport
from agent.agents.bidding_agent.prompts.review import REVIEW_SYSTEM_PROMPT


_CHAPTER_CAP = 4000  # 每章喂给审查模型的正文上限（合规要点集中在前部；整本不截会顶穿上下文窗）


def make_review_node(ctx):
    """graph 节点：读 read+outline+chapters 比对 → 产 RiskReport → 写 state['risk']；模型未提交即失败（可重试）。
    read 走 slim_read 裁 source_quote；章节正文按 _CHAPTER_CAP 截断（防超窗）；
    read.required_structure 非空时一并注入（spec321，供构成覆盖比对），为空时 payload 与此前一致。"""
    async def review_node(state):
        read_state = state.get("read") or {}
        chapters = {cid: (html[:_CHAPTER_CAP] + "…（截断）" if len(html) > _CHAPTER_CAP else html)
                    for cid, html in (state.get("chapters") or {}).items()}
        payload = {"read": slim_read(read_state), "outline": state.get("outline") or {},
                   "chapters": chapters}
        structure = read_state.get("required_structure") or []
        if structure:
            payload["required_structure"] = structure
        user = f"招标与投标材料：\n{json.dumps(payload, ensure_ascii=False)}\n请审查并提交体检报告。"
        result = await run_submit_agent(
            ctx, REVIEW_SYSTEM_PROMPT, user,
            "submit_risk_report", RiskReport, "提交审查报告")
        return {"risk": result.model_dump()}
    return review_node
