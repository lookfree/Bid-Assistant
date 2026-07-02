from __future__ import annotations
from typing import AsyncIterator
from agent.framework.base_agent import BaseAgent
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.graph import build_bidding_workflow, NODE_ORDER


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
            payload = {"file_key": input.get("file_key", ""), "messages": []}
        async for ev in graph.astream(payload, config=config, stream_mode="updates"):
            for node, delta in ev.items():
                yield {"type": "node.end", "node": node, "data": {"delta": delta}}
        # 本 run 停在某个 interrupt：产出"刚完成节点"的结果给 App（带 artifacts 快照，
        # 否则 present/export 步的 pptx/docx key App 拿不到）。
        snap2 = await graph.aget_state(config)
        done = _last_done_node(snap2)
        if done:
            yield {"type": "step.done", "node": done,
                   "data": {"result": snap2.values.get(_RESULT_KEY[done]),
                            "artifacts": snap2.values.get("artifacts", {})}}


_RESULT_KEY = {"read": "read", "outline": "outline", "content": "chapters",
               "review": "risk", "present": "deck", "export": "artifacts"}


def _last_done_node(snap):
    """已写入结果的最后一个节点（按 NODE_ORDER）。"""
    last = None
    for n in NODE_ORDER:
        if snap.values.get(_RESULT_KEY[n]):
            last = n
    return last
