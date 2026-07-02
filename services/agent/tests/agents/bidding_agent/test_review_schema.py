import asyncio
from agent.agents.bidding_agent.schemas import RiskReport
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "score": 78, "high": 1, "mid": 2, "passed": 9,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★不可偏离）",
               "advice": "补 ISO27001 证书并附商务标第四章，否则废标", "target_tab": "business", "target_id": "b4"}],
    "passed_items": ["投标报价未超最高限价", "投标函格式与签章合规"],
}


def test_risk_report_validates():
    r = RiskReport(**_SAMPLE)
    assert r.high == 1 and r.items[0].target_id == "b4" and r.items[0].tone == "destructive"
    # 计数由 items/passed_items 推导，纠正模型口头报数（样例故意给错的 mid=2/passed=9）
    assert r.mid == 0 and r.passed == 2


def test_submit_risk_captures():
    tool, get = make_submit_tool("submit_risk_report", RiskReport, "提交审查报告")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert get().model_dump() == RiskReport(**_SAMPLE).model_dump()   # 捕获即原样往返
