from __future__ import annotations
import asyncio
import json
from agent.framework.create_agent import run_submit_agent
from agent.parsing.service import read_and_parse
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT


def make_read_node(ctx):
    """graph 节点：读招标文件 → 产 ReadResult → 写入 state['read']；模型未提交即失败（可重试）。
    spec315a：节点先确定性解析一次拿条款分句（锚点 sec-N-cM），直接注入 prompt 省掉工具二次解析；
    分句并入 read result 交付前端左栏原文（不另设 state 通道，无第二个读取方）。"""
    async def read_node(state):
        # boto3/解析皆同步 → 丢线程池。注意：工具兜底走的是同一个 read_and_parse——
        # 只对瞬时错误（存储/网络抖动）算二次机会；文件本身损坏则两路都失败，读标退化为无原文可引。
        try:
            parsed = await asyncio.to_thread(read_and_parse, state["file_key"])
            clauses = parsed.clauses
        except Exception:  # noqa: BLE001 降级：让模型自己调 parse_document 重试
            clauses = []
        if clauses:
            user = ("招标文件已解析为条款分句（id 为稳定锚点，clause_ids 直接引用，无需再调 parse_document）：\n"
                    f"{json.dumps(clauses, ensure_ascii=False)}\n\n请读标。")
        else:
            user = f"请对招标文件读标，key={state['file_key']}"
        result = await run_submit_agent(
            ctx, READ_SYSTEM_PROMPT, user,
            "submit_read_result", ReadResult, "提交读标结构化结果",
            extra_tools=[parse_document_tool])
        return {"read": {**result.model_dump(), "doc_sections": clauses}}
    return read_node
