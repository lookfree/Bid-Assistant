from __future__ import annotations

import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.checkpointer import get_checkpointer
from agent.models.gateway import build_gateway
from agent.runtime.registry import get_agent, RunContext
from agent.routes.runs import RunModelOverride
from agent.agents.bidding_agent.nodes.content import rewrite_chapter
import agent.agents.bidding_agent  # noqa: F401 API 进程也注册 bidding_agent（executor 只在 worker 进程导入）

router = APIRouter()


class RewriteBody(BaseModel):
    chapter_id: str
    instruction: str
    base_html: str | None = None  # App 传 DB 里该章现值（编辑过=编辑后）作改写底稿；缺省用 thread state
    model: RunModelOverride | None = None  # spec311 模式：App 下发的模型选择，覆盖 env 默认
    user_id: str | None = None  # 资料库 RAG 属主（spec316 A2）
    # 章标题（App 从**库里的提纲**取，那份才是权威：用户在提纲页新增/改名后，图状态里的
    # outline 直到下次跑 run 才会刷新）。补写新增章时必须靠它，否则守卫认不出这个 id。
    chapter_title: str | None = None


def _make_gateway(model: RunModelOverride | None):
    """per-request 模型覆盖（沿用 spec311 RunModelOverride）：委托统一构造点 build_gateway。"""
    return build_gateway(model.model_dump() if model else None)


@router.post("/agents/{agent_type}/threads/{thread_id}/chapters/rewrite")
async def rewrite(agent_type: str, thread_id: str, body: RewriteBody):
    """单章改写（spec315a 契约 6）：同步路由——取 thread state 该章原文 → LLM 改写 →
    aupdate_state 单章合并回 state（chapters merge reducer 保其余章）→ 返回新 HTML。
    计费在 App API（hold→本调用→persist→settle），agent 依旧 money-blind。"""
    try:
        agent = get_agent(agent_type)                     # 注册表校验，沿用现有模式
    except KeyError:
        return JSONResponse({"error": f"未注册的 agent_type: {agent_type}"}, status_code=404)
    ctx = RunContext(run_id=str(uuid.uuid4()), agent_type=agent_type, thread_id=thread_id,
                     gateway=_make_gateway(body.model), checkpointer=await get_checkpointer(),
                     user_id=body.user_id)
    graph = agent.build_graph(ctx) if hasattr(agent, "build_graph") else None
    if graph is None:                                     # 非工作流型 agent 没有章节概念
        return JSONResponse({"error": f"agent 不支持章节改写: {agent_type}"}, status_code=404)
    config = {"configurable": {"thread_id": thread_id}}
    values = (await graph.aget_state(config)).values or {}
    chapters = values.get("chapters") or {}
    # 校验按**提纲**而不是按已生成章：正文生成被打断时，剩下的章根本不在 chapters 里，
    # 而它们正是用户最需要补写的（页面标着「待生成」）。此前这道守卫在调模型之前就把请求拒了，
    # 用户只看到一句「改写失败，请稍后重试」——2026-08-08 生产实例，观测表里连一次模型调用都没有。
    # 防「拿任意 id 乱调」的初衷不变：提纲里没有的章 id 照样拒。
    known = {c.get("id") for c in (values.get("outline") or {}).get("chapters", []) if c.get("id")}
    # chapter_title 由 App 按库里的提纲校验后下发——图状态里的 outline 只在跑 run 时刷新，
    # 用户在提纲页**新增**的章在它里面根本不存在，而那正是「待生成」的主力。
    if body.chapter_id not in chapters and body.chapter_id not in known and not body.chapter_title:
        return JSONResponse({"error": f"章节不存在: {body.chapter_id}"}, status_code=404)
    if body.base_html is not None:        # DB 编辑后的原文比 agent state 新 → 用它做改写底稿
        values = {**values, "chapters": {**chapters, body.chapter_id: body.base_html}}
    try:
        html = await rewrite_chapter(ctx, body.chapter_id, body.instruction, values,
                                     chapter_title=body.chapter_title)
    except Exception as e:  # noqa: BLE001 LLM/网关错误 → 502 可读错误，App 侧 settleFailed 退款
        return JSONResponse({"error": str(e)}, status_code=502)
    # 只更新该章：chapters 合并 reducer 保证其余章不被覆盖
    await graph.aupdate_state(config, {"chapters": {body.chapter_id: html}})
    return {"chapter_id": body.chapter_id, "html": html}
