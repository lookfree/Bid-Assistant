from __future__ import annotations
from typing import AsyncIterator
from agent.framework.base_agent import BaseAgent, AgentBuild
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.read import build_read


class BiddingAgent(BaseAgent):
    """投标智能体（agent_type="bidding_agent"，整条投标流水线唯一注册单元）。

    Phase 1：工作流只有 read 一个节点（create_agent 式单循环）。
    Phase 2：在 graph.py 装配 read→outline→content→review→present→export 多节点 + 步骤间 HITL 断点；
    本类切到「编译好的工作流图」驱动，对外 astream/run 契约不变。
    """
    agent_type = "bidding_agent"

    def build(self, ctx: RunContext) -> AgentBuild:
        prompt, tools, get_result = build_read(ctx)
        self._get_result = get_result
        return AgentBuild(prompt=prompt, tools=tools)

    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        # 复用框架 astream 跑图流式；末尾把结构化结果作为 run 结果产出
        async for ev in super().astream(input, ctx):
            if ev.get("type") == "node.end":   # 跳过通用占位 result，最终以 submit 捕获为准
                continue
            yield ev
        result = self._get_result()
        # 无论模型是否 submit 都发 read node.end：submit 了给结构化结果，否则 result=None
        # （避免模型没提交时静默留空结果、run 却 succeeded 的假成功）。
        yield {"type": "node.end", "node": "read",
               "data": {"result": result.model_dump() if result is not None else None}}
