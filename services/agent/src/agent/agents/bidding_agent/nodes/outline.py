from __future__ import annotations
import json
from agent.framework.structured import make_submit_tool
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.schemas import Outline
from agent.agents.bidding_agent.prompts.outline import OUTLINE_SYSTEM_PROMPT


def make_outline_node(ctx):
    """graph 节点：读 state['read']（读标结论）→ 产 Outline → 写 state['outline']。"""
    async def outline_node(state):
        submit, get_result = make_submit_tool("submit_outline", Outline, "提交提纲")
        sub = build_create_agent(OUTLINE_SYSTEM_PROMPT, [submit], ctx)
        read = json.dumps(state.get("read", {}), ensure_ascii=False)
        await sub.ainvoke({"messages": [{"role": "user", "content": f"读标结论：\n{read}\n请据此产出提纲。"}]})
        result = get_result()
        return {"outline": result.model_dump() if result else {"chapters": []}}
    return outline_node
