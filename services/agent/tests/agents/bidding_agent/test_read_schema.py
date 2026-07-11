import asyncio
from agent.agents.bidding_agent.schemas import ReadResult
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "project_meta": {"name": "某市政务云运维", "code": "ZCY-2026-018", "budget": "￥1,680 万"},
    "categories": [
        {"key": "qualification", "title": "资格要求", "items": [
            {"title": "★信息安全认证", "value": "ISO27001（不可偏离）",
             "clause_ids": ["sec-qualification-c2"], "source_quote": "取得★ISO27001…",
             "status": "found", "risk": True, "star": True},
            {"title": "证明清单", "value": "未给出对照清单", "status": "missing"},
        ]},
    ],
    "scoring": [{"id": "sc-tech-1", "category": "技术方案", "name": "★运维服务体系", "score": 20,
                 "star": True, "clause_ids": ["sec-technical-c2"], "chapter_id": "t3"}],
    "risk_summary": ["ISO27001 不可偏离，缺失即废标"],
}


def test_read_result_validates():
    r = ReadResult(**_SAMPLE)
    assert r.categories[0].items[0].risk is True and r.categories[0].items[1].status == "missing"


def test_read_result_required_structure_defaults_empty():
    """旧读标结果无 required_structure 字段 → 默认空列表（向后兼容，spec321）。"""
    r = ReadResult(**_SAMPLE)
    assert r.required_structure == []


def test_read_result_required_structure_round_trip():
    sample = {**_SAMPLE, "required_structure": [
        {"id": "s1", "title": "技术标（分册）", "kind": "volume", "required": True,
         "clause_ids": ["sec-format-c1"], "source_quote": "投标文件分为技术标、商务标两个分册"},
        {"id": "s2", "title": "密封与签章", "kind": "rule", "required": True,
         "notes": "正本1份副本4份，密封加盖公章骑缝章"},
    ]}
    r = ReadResult(**sample)
    assert [s.id for s in r.required_structure] == ["s1", "s2"]
    assert r.required_structure[0].kind == "volume" and r.required_structure[1].kind == "rule"
    assert r.required_structure[0].required is True and r.required_structure[0].notes == ""


def test_submit_read_tool_captures():
    tool, get = make_submit_tool("submit_read_result", ReadResult, "提交读标结果")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert isinstance(get(), ReadResult) and get().scoring[0].score == 20
