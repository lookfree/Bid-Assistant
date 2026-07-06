from __future__ import annotations
from typing import AsyncIterator
from langgraph.errors import InvalidUpdateError
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
        if snap.values:                              # 已有状态 → 灌入本 run 参数/编辑回写后续跑下一节点
            # 注意：interrupt 断点上直接 astream(dict) 会从 START 重跑整图（实测 langgraph 1.2.7），
            # 故用 aupdate_state 做状态增量更新（run_input 覆盖 + overrides 走各通道 reducer），
            # 再 payload=None 从断点继续（spec315a 契约 2 的语义实现）。
            # as_node 默认推断为「最后完成的节点」→ 位置不变；尚无节点完成（如首节点失败后重试）
            # 推断不出会抛 InvalidUpdateError → 按 START 写入，位置仍是首节点。
            try:
                await graph.aupdate_state(config, _resume_update(input))
            except InvalidUpdateError:
                await graph.aupdate_state(config, _resume_update(input), as_node="__start__")
            payload = None
        else:                                        # 新标书 → 从 read 起（read 节点用 state['file_key']）
            payload = {"file_key": input.get("file_key", ""),
                       "run_input": input.get("run_input") or {}}
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

# App 可回灌的编辑产物白名单（spec315a）：已存/已编辑的提纲/正文/幻灯片
_OVERRIDE_KEYS = ("outline", "chapters", "deck")


def _resume_update(input: dict) -> dict:
    """续跑前的状态增量：run_input 每 run 覆盖；state_overrides 只取白名单键且非空的。"""
    update: dict = {"run_input": input.get("run_input") or {}}
    overrides = input.get("state_overrides") or {}
    for k in _OVERRIDE_KEYS:
        v = overrides.get(k)
        if v:
            update[k] = v
    return update
