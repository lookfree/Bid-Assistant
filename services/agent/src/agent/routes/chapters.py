from __future__ import annotations

import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.config import settings
from agent.checkpointer import get_checkpointer
from agent.models.gateway import ModelGateway, model_override_to_settings
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


def _make_gateway(model: RunModelOverride | None) -> ModelGateway:
    """per-request 模型覆盖（沿用 spec311 RunModelOverride）：有 override 才 copy settings。"""
    override = model_override_to_settings(model.model_dump() if model else None)
    return ModelGateway(settings.model_copy(update=override) if override else settings)


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
                     gateway=_make_gateway(body.model), checkpointer=await get_checkpointer())
    graph = agent.build_graph(ctx) if hasattr(agent, "build_graph") else None
    if graph is None:                                     # 非工作流型 agent 没有章节概念
        return JSONResponse({"error": f"agent 不支持章节改写: {agent_type}"}, status_code=404)
    config = {"configurable": {"thread_id": thread_id}}
    values = (await graph.aget_state(config)).values or {}
    chapters = values.get("chapters") or {}
    if body.chapter_id not in chapters:   # base_html 也要求该章在 state 存在，防拿任意 id 乱调
        return JSONResponse({"error": f"章节不存在: {body.chapter_id}"}, status_code=404)
    if body.base_html is not None:        # DB 编辑后的原文比 agent state 新 → 用它做改写底稿
        values = {**values, "chapters": {**chapters, body.chapter_id: body.base_html}}
    try:
        html = await rewrite_chapter(ctx, body.chapter_id, body.instruction, values)
    except Exception as e:  # noqa: BLE001 LLM/网关错误 → 502 可读错误，App 侧 settleFailed 退款
        return JSONResponse({"error": str(e)}, status_code=502)
    # 只更新该章：chapters 合并 reducer 保证其余章不被覆盖
    await graph.aupdate_state(config, {"chapters": {body.chapter_id: html}})
    return {"chapter_id": body.chapter_id, "html": html}
