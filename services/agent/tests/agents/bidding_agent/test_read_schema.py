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


def test_submit_read_tool_captures():
    tool, get = make_submit_tool("submit_read_result", ReadResult, "提交读标结果")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert isinstance(get(), ReadResult) and get().scoring[0].score == 20
