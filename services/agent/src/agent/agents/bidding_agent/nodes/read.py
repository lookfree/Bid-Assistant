from __future__ import annotations
import asyncio
import json
import logging
from agent.framework.create_agent import run_submit_agent
from agent.parsing.service import read_and_parse
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT
from agent.db import get_pool
from agent.rag import store as rag_store
from agent.rag import retrieve as rag_retrieve

logger = logging.getLogger(__name__)


async def _index_tender(ctx, run_input: dict, clauses: list[dict]) -> None:
    """best-effort 索引招标条款分句供 RAG 检索（spec316 A2）：条款已是天然分块，不再过 chunker。
    整段 try/except（含 gate 判定），任何异常仅 warning，绝不影响 read 交付。"""
    if not clauses:
        return
    try:
        if not await rag_retrieve.rag_enabled(ctx.user_id, run_input):
            return
        texts = [c.get("text", "") for c in clauses]
        vectors = await rag_retrieve.embedder.embed(texts)
        metas = [{"clause_id": c.get("id")} for c in clauses]
        await asyncio.to_thread(rag_store.upsert, get_pool(), ctx.user_id, "tender",
                                 ctx.thread_id, texts, vectors, metas)
    except Exception:  # noqa: BLE001 索引失败（含 gate 抛错）绝不影响 read 节点交付
        logger.warning("rag index tender failed thread_id=%s", ctx.thread_id, exc_info=True)


def make_read_node(ctx):
    """graph 节点：读招标文件 → 产 ReadResult → 写入 state['read']；模型未提交即失败（可重试）。
    spec315a：节点先确定性解析一次拿条款分句（锚点 sec-N-cM），直接注入 prompt 省掉工具二次解析；
    分句并入 read result 交付前端左栏原文（不另设 state 通道，无第二个读取方）。
    spec316 A2：分句到手后 best-effort 索引进资料库 RAG（source_type=tender），供后续内容生成检索引用。"""
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
        await _index_tender(ctx, state.get("run_input") or {}, clauses)
        return {"read": {**result.model_dump(), "doc_sections": clauses}}
    return read_node
