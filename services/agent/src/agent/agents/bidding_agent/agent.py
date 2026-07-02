from __future__ import annotations
from typing import AsyncIterator
from agent.framework.base_agent import BaseAgent
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.graph import build_bidding_workflow


class BiddingAgent(BaseAgent):
    """投标智能体（agent_type="bidding_agent"）：一条多节点工作流，步骤间 interrupt。
    每个 run 推进到下一个断点即止；同 thread_id 反复发 run 逐步走完全流程。"""
    agent_type = "bidding_agent"

    def build_graph(self, ctx: RunContext):
        return build_bidding_workflow(ctx)

    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        await self._ensure_checkpointer(ctx)   # 真实 run 补 Postgres checkpointer；测试注入 MemorySaver
        graph = self._compile(ctx)
        config = {"configurable": {"thread_id": ctx.thread_id}}
        # 判定：该 thread 是否已有 checkpoint（已起过 → 续跑；否则用 input 播种）
        snap = await graph.aget_state(config)
        if snap.values:                              # 已有状态 → 续跑下一节点
            payload = None
        else:                                        # 新标书 → 从 read 起（read 节点用 state['file_key']）
            payload = {"file_key": input.get("file_key", "")}
        # 记「本 run 实际跑过的最后一个节点」：靠流事件而非 state 真值判定——
        # 否则节点产空结果（如模型没 submit → read={}）会被当成没跑，漏发 step.done、假成功。
        ran_node = None
        async for ev in graph.astream(payload, config=config, stream_mode="updates"):
            for node, delta in ev.items():
                if node == "__interrupt__":          # interrupt_after 的断点标记，不是业务节点
                    continue
                ran_node = node
                yield {"type": "node.end", "node": node, "data": {"delta": delta}}
        # 本 run 停在该节点后的 interrupt：产出其结果给 App（带 artifacts 快照，
        # 否则 present/export 步的 pptx/docx key App 拿不到）。
        if ran_node:
            values = (await graph.aget_state(config)).values or {}
            yield {"type": "step.done", "node": ran_node,
                   "data": {"result": values.get(_RESULT_KEY[ran_node]),
                            "artifacts": values.get("artifacts", {})}}


_RESULT_KEY = {"read": "read", "outline": "outline", "content": "chapters",
               "review": "risk", "present": "deck", "export": "artifacts"}
