from __future__ import annotations
from agent.framework.create_agent import run_submit_agent
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT


def make_read_node(ctx):
    """graph 节点：读招标文件 → 产 ReadResult → 写入 state['read']；模型未提交即失败（可重试）。"""
    async def read_node(state):
        result = await run_submit_agent(
            ctx, READ_SYSTEM_PROMPT, f"请对招标文件读标，key={state['file_key']}",
            "submit_read_result", ReadResult, "提交读标结构化结果",
            extra_tools=[parse_document_tool])
        return {"read": result.model_dump()}
    return read_node
