import asyncio
from agent.runtime.registry import RunContext
from agent.parsing.types import ParsedDoc
from agent.agents.bidding_agent.nodes import read as read_mod

_READ_ARGS = {
    "categories": [{"key": "qualification", "title": "资格要求",
                    "items": [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
    "risk_summary": ["缺 ISO27001 即废标"],
}
_CLAUSES = [{"id": "sec-1-c1", "text": "项目名称：某某平台建设"},
            {"id": "sec-2-c1", "text": "投标人须具备 ISO27001 认证"}]


def test_read_node_emits_doc_sections(monkeypatch, submit_gateway):
    """spec315a：节点确定性解析一次 → doc_sections 并入 read result（不设独立 state 通道，
    唯一消费方是前端左栏，双份落地徒增 checkpoint 体积）。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/tender.docx"}))
    assert out["read"]["doc_sections"] == _CLAUSES              # 随 result 交付前端
    assert "doc_sections" not in out                            # 不再写独立通道
    assert out["read"]["risk_summary"] == ["缺 ISO27001 即废标"]  # 结构化读标不受影响


def test_read_node_degrades_when_parse_fails(monkeypatch, submit_gateway):
    """解析瞬时失败不炸整步：降级回工具路径（同源 read_and_parse，仅瞬时错误有二次机会），
    doc_sections=[]。"""
    def boom(key):
        raise RuntimeError("存储抖动")
    monkeypatch.setattr(read_mod, "read_and_parse", boom)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/broken.pdf"}))
    assert out["read"]["doc_sections"] == []
    assert out["read"]["risk_summary"] == ["缺 ISO27001 即废标"]
