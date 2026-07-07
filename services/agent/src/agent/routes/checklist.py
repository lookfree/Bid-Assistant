from __future__ import annotations

import io
import uuid
from datetime import date
from typing import Literal

from docx import Document
from fastapi import APIRouter
from pydantic import BaseModel

from agent.parsing.storage_read import storage

# spec315b 契约 3：POST /render/checklist 同步无状态渲染——不进 thread、不涉计费，
# App 把模板+状态合成后灌进来，agent 出 .docx 落 MinIO 返回 key（预签名在 App API 做）。

router = APIRouter()

_STATUS_LABEL = {"pass": "✓ 通过", "risk": "⚠ 风险", "pending": "待办"}
_DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class ChecklistItem(BaseModel):
    text: str
    status: Literal["pass", "risk", "pending"] = "pending"
    owner: str = ""
    note: str = ""
    # 知识库命中：可空展示字符串（如「已具备 · 营业执照」），直接作为一列输出，null 显示 —
    library_hit: str | None = None


class ChecklistGroup(BaseModel):
    id: str
    title: str
    items: list[ChecklistItem]


class ChecklistBody(BaseModel):
    title: str
    project_name: str | None = None
    groups: list[ChecklistGroup]


def render_checklist_docx(body: ChecklistBody) -> bytes:
    """终极审核表 .docx：标题+项目名+日期，每组一张五列表格
    （检查项/状态/责任人/备注/知识库），末尾签字/日期栏。
    与 render/docx.py 同风格：python-docx 直出，确定性无 LLM。"""
    doc = Document()
    doc.add_heading(body.title, level=0)
    if body.project_name:
        doc.add_paragraph(f"项目名称：{body.project_name}")
    doc.add_paragraph(f"导出日期：{date.today().isoformat()}")
    for g in body.groups:
        doc.add_heading(g.title, level=1)
        t = doc.add_table(rows=len(g.items) + 1, cols=5)
        t.style = "Table Grid"
        for j, h in enumerate(("检查项", "状态", "责任人", "备注", "知识库")):
            t.rows[0].cells[j].text = h
        for i, item in enumerate(g.items, start=1):
            row = (item.text, _STATUS_LABEL[item.status], item.owner, item.note,
                   item.library_hit or "—")
            for j, v in enumerate(row):
                t.rows[i].cells[j].text = v
    doc.add_paragraph("")
    doc.add_paragraph("审核人（签字）：____________________    日期：____________")
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


@router.post("/render/checklist")
async def render_checklist(body: ChecklistBody):
    """渲染 → 上传 MinIO artifacts/checklist/<uuid>.docx → {key}。"""
    data = render_checklist_docx(body)
    key = f"artifacts/checklist/{uuid.uuid4()}.docx"
    await storage.put_bytes(key, data, content_type=_DOCX_CT)
    return {"key": key}
