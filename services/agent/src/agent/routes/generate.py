from __future__ import annotations

import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from agent.models.gateway import build_gateway
from agent.runtime.registry import RunContext
from agent.routes.runs import RunModelOverride
from agent.agents.bidding_agent.checklist_gen import generate_checklist

# spec333 定制审核表生成：同步无状态——App 传已存的读标结论 + 后台模型选择，agent 一次 LLM 调用产
# 分组核对项返回。计费归属读标步（App 侧 best-effort 调用，不预扣不结算），agent 依旧 money-blind。

router = APIRouter()


class GenerateChecklistBody(BaseModel):
    read_result: dict = Field(default_factory=dict)  # 读标结论（project_meta/categories/risk_summary/required_structure…）
    model: RunModelOverride | None = None            # App 下发的模型选择（覆盖 env 默认，同 rewrite）


def _group_id(i: int) -> str:
    """组 id 服务端归一化为数字序号（1,2,3…）：防模型给重复/空 id，保证状态 key 干净唯一。
    刻意用数字而非字母——前端默认 36 条表用 A–H 字母 id，数字 id 与之天然不冲突，避免
    「默认表上标注的状态（key=A-0）在定制表生成后错位套到定制表同位条目」的静默串档。"""
    return str(i + 1)


@router.post("/generate/checklist")
async def generate_checklist_route(body: GenerateChecklistBody):
    """读标结论 → 定制审核表 {groups:[{id,title,items:[str]}]}。模型失败/未提交 → 502（App 回落默认 36）。"""
    ctx = RunContext(run_id=str(uuid.uuid4()), agent_type="bidding_agent", thread_id="",
                     gateway=build_gateway(body.model.model_dump() if body.model else None))
    try:
        result = await generate_checklist(ctx, body.read_result)
    except Exception as e:  # noqa: BLE001 LLM/网关/未提交 → 502 可读错误，App 侧回落默认 36
        return JSONResponse({"error": str(e)}, status_code=502)
    groups = [{"id": _group_id(i), "title": g.title, "items": g.items}
              for i, g in enumerate(result.groups)]
    return {"groups": groups}
