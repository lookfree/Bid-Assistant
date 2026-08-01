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


def test_findings_and_passed_items_are_required_in_the_tool_schema():
    """审查步的全部产出就是这两个列表。它们可选且无描述时，弱模型（2026-08-01 起主模型是客户本地的
    Qwen3.6-35B-A3B-W4A8）会整个省略 → 默认值补成 [] → 前端显示「0 项风险」。这比报错危险得多：
    看起来像「这份标书没问题」，用户会带着一份没体检过的标书去投。空数组仍合法（真干净就是没有发现），
    但必须由模型显式给出。同一根因见提纲 OutlineChapter.items。"""
    from langchain_core.utils.function_calling import convert_to_openai_tool
    import pytest
    from pydantic import ValidationError

    params = convert_to_openai_tool(
        make_submit_tool("submit_risk_report", RiskReport, "提交审查报告")[0])["function"]["parameters"]
    for f in ("items", "passed_items"):
        assert f in params.get("required", []), f"{f} 不是必填，模型可以整个省掉 → 静默变成「0 项风险」"
        assert "必填" in (params["properties"][f].get("description") or ""), f"{f} 没有字段说明"
    # 整改建议是一条发现的全部价值，必须在 schema 里说清楚要写什么
    finding = params["properties"]["items"]["items"]["properties"]
    assert "整改建议" in (finding["advice"].get("description") or "")

    with pytest.raises(ValidationError):     # 省略 items 必须被拒，而不是默认成空数组静默通过
        RiskReport(score=90, passed_items=[])
