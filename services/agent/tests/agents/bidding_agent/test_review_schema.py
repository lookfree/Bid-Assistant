import asyncio
from agent.agents.bidding_agent.schemas import RiskReport
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "score": 78, "high": 1, "mid": 2, "passed": 9,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★不可偏离）",
               "advice": "补 ISO27001 证书并附商务标第四章，否则废标", "target_tab": "business", "target_id": "b4", "anchor_text": "ISO27001 认证证书复印件"}],
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


# 2026-08-06 用户实测截图：三张「高风险」卡片长这样——
#   标题「响应文件构成缺漏——缺少」（断在半句），整改建议一片空白，而且三条一模一样。
# 整改建议是这条发现的**全部价值**：只说"有问题"不说怎么改，用户拿到的是一句空话。
# 此前 advice 是可选带默认值（怕漏填让整单被拒），实测结果是空建议直接发给了付费用户。
# _forced_submit 会把校验错误喂回模型重试 3 轮，正是为这种情况准备的。
def _item(**over):
    base = {"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001",
            "advice": "补证书并附商务标第四章", "target_tab": "business", "target_id": "b4", "anchor_text": "ISO27001 认证证书复印件"}
    return {**base, **over}


def test_empty_advice_is_rejected():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        RiskReport(score=80, items=[_item(advice="")], passed_items=[])
    with pytest.raises(ValidationError):
        RiskReport(score=80, items=[_item(advice="   ")], passed_items=[])


def test_empty_title_is_rejected():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        RiskReport(score=80, items=[_item(title="")], passed_items=[])


def test_identical_items_collapse():
    """同一条发现重复三遍是噪音（用户截图里就是三张一样的卡）。去重不丢信息。"""
    r = RiskReport(score=80, items=[_item(), _item(), _item()], passed_items=[])
    assert len(r.items) == 1
    assert r.high == 1                      # 计数跟着去重后的结果走


def test_different_items_are_kept():
    r = RiskReport(score=80, items=[_item(), _item(title="缺少授权书")], passed_items=[])
    assert len(r.items) == 2


def test_advice_is_required_in_the_tool_schema():
    """工具 schema 里必须标成 required——弱模型只读 schema，不读提示词散文。"""
    tool, _ = make_submit_tool("submit_risk", RiskReport, "提交审查结果")
    from langchain_core.utils.function_calling import convert_to_openai_tool
    params = convert_to_openai_tool(tool)["function"]["parameters"]
    item = params["properties"]["items"]["items"]   # RiskFinding 被内联在数组项里
    assert "advice" in item["required"]
    assert item["properties"]["advice"].get("description")


def test_anchor_text_is_required_but_may_be_empty():
    """章内定位锚点：必填、可空。

    必填——弱模型对"可选且无描述"的字段的做法是整个省略（2026-08-01 实测），
    而字段一旦缺席，定位就退回章节顶部，等于这个功能没做。
    可空——"缺少某材料"这类问题未必有可摘抄的原文，逼模型编一段会把用户带到错的地方。
    """
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import RiskFinding

    base = dict(level="高风险", tone="destructive", title="缺 ISO27001",
                advice="补证书", target_tab="business", target_id="b4")
    try:
        RiskFinding(**base)
    except ValidationError:
        pass
    else:
        raise AssertionError("anchor_text 缺席竟然通过了校验——弱模型会直接省略它")

    assert RiskFinding(**base, anchor_text="").anchor_text == ""
    assert RiskFinding(**base, anchor_text="采购需求偏离表（附件5-1）").anchor_text == "采购需求偏离表（附件5-1）"
