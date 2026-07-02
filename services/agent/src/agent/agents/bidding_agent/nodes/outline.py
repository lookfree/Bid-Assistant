from __future__ import annotations
import json
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import slim_read
from agent.agents.bidding_agent.schemas import Outline
from agent.agents.bidding_agent.prompts.outline import OUTLINE_SYSTEM_PROMPT


def make_outline_node(ctx):
    """graph 节点：读 state['read']（读标结论）→ 产 Outline → 写 state['outline']；模型未提交即失败（可重试）。"""
    async def outline_node(state):
        read = json.dumps(slim_read(state.get("read") or {}), ensure_ascii=False)
        result = await run_submit_agent(
            ctx, OUTLINE_SYSTEM_PROMPT, f"读标结论：\n{read}\n请据此产出提纲。",
            "submit_outline", Outline, "提交提纲")
        return {"outline": result.model_dump()}
    return outline_node
