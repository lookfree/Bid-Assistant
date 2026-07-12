import json

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk


@pytest.fixture(autouse=True)
def _no_real_object_storage(monkeypatch):
    """read 节点的确定性解析（spec315a）默认打桩为失败 → 走降级路径，不打真实 MinIO；
    需要条款分句的测试在用例内自行覆盖 read_and_parse。"""
    from agent.agents.bidding_agent.nodes import read as read_mod

    def _unavailable(key):
        raise RuntimeError("测试环境无对象存储")
    monkeypatch.setattr(read_mod, "read_and_parse", _unavailable)


class SubmitChat:
    """通用 fake 模型：首轮按 bind 到的工具名从 args_by_tool 取参调用 submit，次轮回 reply 收尾。
    args_by_tool 为空/不匹配即模拟"模型不提交"；reply 可定制，纯文本回复型测试（如改写）也用它。"""

    def __init__(self, args_by_tool: dict, reply: str = "done"):
        self.args_by_tool = args_by_tool
        self.reply = reply
        self.tool_names: list[str] = []
        self.n = 0
        self.last_messages: list = []       # 每轮入参消息（供测试断言注入的 prompt/user 内容）

    def bind_tools(self, tools, **kw):                # 兼容 tool_choice 强制路径
        self.tool_names = [t.name for t in tools]
        return self

    def _turn(self):
        self.n += 1
        if self.n == 1:
            name = next((n for n in self.tool_names if n in self.args_by_tool), None)
            if name:
                return name
        return None

    async def ainvoke(self, messages):
        self.last_messages = messages
        name = self._turn()
        if name:
            return AIMessage(content="", tool_calls=[{"name": name, "args": self.args_by_tool[name], "id": "c1"}])
        return AIMessage(content=self.reply)

    async def astream(self, messages, **kw):          # 流式路径（forced_stream_submit）：单块即整条结果
        self.last_messages = messages
        name = self._turn()
        if name:
            yield AIMessageChunk(content="", tool_call_chunks=[
                {"name": name, "args": json.dumps(self.args_by_tool[name]), "id": "c1", "index": 0}])
        else:
            yield AIMessageChunk(content=self.reply)


class SubmitGateway:
    """每次 get_chat 给一个新 SubmitChat：各节点的子 agent 轮次互不串扰。
    chats 记录每个创建出的 SubmitChat 实例，供测试取 last_messages 断言注入的 prompt。"""

    def __init__(self, args_by_tool: dict, reply: str = "done"):
        self.args_by_tool = args_by_tool
        self.reply = reply
        self.chats: list[SubmitChat] = []

    def get_chat(self, **kw):
        chat = SubmitChat(self.args_by_tool, self.reply)
        self.chats.append(chat)
        return chat

    def chain(self):                                  # 单项链：无降级模型，forced_stream_submit 同模型重试
        return [{"provider": None, "model": None, "base_url": None, "api_key": None}]


@pytest.fixture
def submit_gateway():
    """按 {submit工具名: 提交参数} 造 fake gateway，供 read/outline/... 各节点测试共用。"""
    return SubmitGateway
