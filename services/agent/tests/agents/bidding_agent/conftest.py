import pytest
from langchain_core.messages import AIMessage


class SubmitChat:
    """通用 fake 模型：首轮按 bind 到的工具名从 args_by_tool 取参调用 submit，次轮收尾。"""

    def __init__(self, args_by_tool: dict):
        self.args_by_tool = args_by_tool
        self.tool_names: list[str] = []
        self.n = 0

    def bind_tools(self, tools):
        self.tool_names = [t.name for t in tools]
        return self

    async def ainvoke(self, messages):
        self.n += 1
        if self.n == 1:
            name = next((n for n in self.tool_names if n in self.args_by_tool), None)
            if name:                              # 没配对应工具参数 → 模拟"模型不提交"
                return AIMessage(content="", tool_calls=[{"name": name, "args": self.args_by_tool[name], "id": "c1"}])
        return AIMessage(content="done")


class SubmitGateway:
    """每次 get_chat 给一个新 SubmitChat：各节点的子 agent 轮次互不串扰。"""

    def __init__(self, args_by_tool: dict):
        self.args_by_tool = args_by_tool

    def get_chat(self, **kw):
        return SubmitChat(self.args_by_tool)


@pytest.fixture
def submit_gateway():
    """按 {submit工具名: 提交参数} 造 fake gateway，供 read/outline/... 各节点测试共用。"""
    return SubmitGateway
