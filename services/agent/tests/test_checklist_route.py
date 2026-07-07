"""spec315b 契约 3：POST /render/checklist（mock storage，断言返回 key 且 upload 被调）。"""
import io
import uuid

from agent.routes import checklist as checklist_mod
from agent.routes.checklist import (ChecklistBody, ChecklistGroup, ChecklistItem,
                                    render_checklist)

_BODY = ChecklistBody(
    title="投标文件终极审核表",
    project_name="智慧园区综合管理平台项目",
    groups=[ChecklistGroup(id="g1", title="资质文件", items=[
        ChecklistItem(text="营业执照副本已盖章", status="pass", owner="张三"),
        ChecklistItem(text="授权委托书原件", status="risk", owner="李四",
                      note="缺法人签字", library_hit="缺失 · 授权委托书"),
        ChecklistItem(text="业绩合同复印件", status="pending"),
    ])])


class _Storage:
    def __init__(self):
        self.calls: list[tuple[str, bytes, str]] = []

    async def put_bytes(self, key, data, content_type=None):
        self.calls.append((key, data, content_type))


async def test_render_checklist_uploads_and_returns_key(monkeypatch):
    store = _Storage()
    monkeypatch.setattr(checklist_mod, "storage", store)
    res = await render_checklist(_BODY)
    assert len(store.calls) == 1                               # upload 被调且只调一次
    key, data, ct = store.calls[0]
    assert res == {"key": key}
    assert key.startswith("artifacts/checklist/") and key.endswith(".docx")
    uuid.UUID(key.removeprefix("artifacts/checklist/").removesuffix(".docx"))  # 中段是合法 uuid
    assert "wordprocessingml" in ct and len(data) > 0


async def test_render_checklist_docx_content(monkeypatch):
    """回读 docx：状态中文映射（✓/⚠/待办）、知识库列（字符串/空→—）、签字栏都在。"""
    store = _Storage()
    monkeypatch.setattr(checklist_mod, "storage", store)
    await render_checklist(_BODY)
    from docx import Document
    doc = Document(io.BytesIO(store.calls[0][1]))
    cells = [c.text for t in doc.tables for r in t.rows for c in r.cells]
    assert "检查项" in cells and "营业执照副本已盖章" in cells
    assert "✓ 通过" in cells and "⚠ 风险" in cells and "待办" in cells
    assert "知识库" in cells                                    # 知识库独立一列
    assert "缺失 · 授权委托书" in cells                          # 命中字符串原样输出
    assert "—" in cells and "缺法人签字" in cells                # 未命中显示 —；备注照常
    paras = [p.text for p in doc.paragraphs]
    assert any("智慧园区" in p for p in paras)
    assert any("签字" in p for p in paras)                     # 末尾签字/日期栏
