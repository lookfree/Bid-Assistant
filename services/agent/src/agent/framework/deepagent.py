from __future__ import annotations

from dataclasses import dataclass, field
from deepagents import create_deep_agent     # 动态规划(todos)+子智能体(task)+虚拟FS
from agent.framework.base_agent import BaseAgent
from agent.runtime.registry import RunContext


@dataclass
class DeepBuild:
    instructions: str
    tools: list = field(default_factory=list)
    subagents: list = field(default_factory=list)   # 子智能体定义（可空）


class DeepAgent(BaseAgent):
    """deepagent 式节点基类：子类实现 deep_build()。
    deepagents 默认用 in-state 虚拟文件系统、不开 execute（与 §4.5 一致），
    可随 checkpointer 续跑（§4.7：虚拟 FS 在图 state 内）。"""

    def deep_build(self, ctx: RunContext) -> DeepBuild:
        raise NotImplementedError

    def _compile(self, ctx: RunContext):
        cfg = self.deep_build(ctx)
        model = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
        # deepagents 0.6.x：提示词参数是 system_prompt（旧文档的 instructions 已改名）。
        return create_deep_agent(
            tools=cfg.tools,
            system_prompt=cfg.instructions,
            model=model,
            subagents=cfg.subagents or None,
            checkpointer=ctx.checkpointer,   # 与 BaseAgent._compile(ctx) 同签名，走 ctx 上的 checkpointer
        )
