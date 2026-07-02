from __future__ import annotations
from agent.framework.structured import make_submit_tool
from agent.framework.create_agent import build_create_agent
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT


def build_read(ctx):
    """读标节点（create_agent 式）。返回 (prompt, tools, get_result)。
    get_result() 取 submit 捕获的 ReadResult（未提交则 None）。"""
    submit, get_result = make_submit_tool("submit_read_result", ReadResult, "提交读标结构化结果")
    return READ_SYSTEM_PROMPT, [parse_document_tool, submit], get_result


def make_read_node(ctx):
    """graph 节点：读招标文件 → 产 ReadResult → 写入 state['read']。"""
    async def read_node(state):
        prompt, tools, get_result = build_read(ctx)
        sub = build_create_agent(prompt, tools, ctx)            # 一个 create_agent 子图
        text = f"请对招标文件读标，key={state['file_key']}"
        await sub.ainvoke({"messages": [{"role": "user", "content": text}]})
        result = get_result()
        return {"read": result.model_dump() if result else {}}
    return read_node
