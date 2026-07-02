from __future__ import annotations
import json
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.schemas import RiskReport
from agent.agents.bidding_agent.prompts.review import REVIEW_SYSTEM_PROMPT


def make_review_node(ctx):
    """graph 节点：读 read+outline+chapters 比对 → 产 RiskReport → 写 state['risk']；模型未提交即失败（可重试）。"""
    async def review_node(state):
        payload = {"read": state.get("read", {}), "outline": state.get("outline", {}),
                   "chapters": state.get("chapters", {})}
        user = "招标与投标材料：\n" + json.dumps(payload, ensure_ascii=False) + "\n请审查并提交体检报告。"
        result = await run_submit_agent(
            ctx, REVIEW_SYSTEM_PROMPT, user,
            "submit_risk_report", RiskReport, "提交审查报告")
        return {"risk": result.model_dump()}
    return review_node
