from __future__ import annotations
from agent.framework.structured import make_submit_tool
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT


def build_read(ctx):
    """读标节点（create_agent 式）。返回 (prompt, tools, get_result)。
    get_result() 取 submit 捕获的 ReadResult（未提交则 None）。
    Phase 2：此函数作为 bidding_agent 工作流的 `read` 节点被 graph.py 装配（产出写入 BiddingState['read']）。"""
    submit, get_result = make_submit_tool("submit_read_result", ReadResult, "提交读标结构化结果")
    return READ_SYSTEM_PROMPT, [parse_document_tool, submit], get_result
