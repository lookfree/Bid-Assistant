from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Protocol


@dataclass
class RunContext:
    run_id: str
    agent_type: str
    thread_id: str
    recorder: Any
    gateway: Any = None
    redis: Any = None


class AgentProtocol(Protocol):
    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:  # 事件 {type, data, node?}
        ...


AgentFactory = Callable[[], AgentProtocol]
AGENT_REGISTRY: dict[str, AgentFactory] = {}


def register(agent_type: str, factory: AgentFactory) -> None:
    AGENT_REGISTRY[agent_type] = factory


def get_agent(agent_type: str) -> AgentProtocol:
    if agent_type not in AGENT_REGISTRY:
        raise KeyError(f"未注册的 agent_type: {agent_type}")
    return AGENT_REGISTRY[agent_type]()
