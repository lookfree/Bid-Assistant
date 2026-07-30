import asyncio
from agent.agents.bidding_agent.schemas import DeckDraft, DeckSpec
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "title": "某市政务云运维 述标", "duration": 15, "template": "gov",
    "slides": [
        {"id": "s0", "title": "封面", "kind": "cover", "bullets": []},
        {"id": "s1", "title": "运维服务体系", "scoring": "技术方案 50 分",
         "bullets": ["7×24 值守", "分级 SLA"], "notes": "各位评委，我方运维体系…", "kind": "content"},
        {"id": "s9", "title": "致谢", "kind": "end", "bullets": []},
    ],
    "qa": [{"q": "如何保障 99.9% 可用性？", "a": "统一监控+分级响应+主动巡检…"}],
}


def test_deck_validates():
    d = DeckSpec(**_SAMPLE)
    assert d.duration == 15 and d.slides[0].kind == "cover" and d.qa[0].q.endswith("？")


def test_submit_deck_captures():
    tool, get = make_submit_tool("submit_deck", DeckSpec, "提交述标 DeckSpec")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert get().model_dump() == DeckSpec(**_SAMPLE).model_dump()   # 捕获即原样往返


def test_content_slide_without_bullets_is_rejected():
    """生产事故：模型只提交标题、bullets 缺省成空列表 → 14 页全空的 PPT 照样交付并扣 80 积分。
    正文页必须有要点，校验失败会触发强制提交重试；封面/尾页本就无要点，不受此限。"""
    import pytest
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import SlideDraft

    with pytest.raises(ValidationError):
        SlideDraft(id="s2", title="总体技术思路", kind="content", bullets=[])
    with pytest.raises(ValidationError):
        SlideDraft(id="s3", title="实施策略", kind="content", bullets=["  ", ""])  # 空白字符串不算要点
    SlideDraft(id="s1", title="项目名称", kind="cover", bullets=[])          # 封面无要点合法
    SlideDraft(id="s4", title="致谢", kind="end", bullets=[])                # 尾页同理
    SlideDraft(id="s5", title="方案框架", kind="content", bullets=["分层解耦，网关统一鉴权"])


def test_section_kind_needs_no_bullets_or_scoring():
    """章节分隔页（结构性升级）：只是过渡页，不要求 bullets/scoring——与 cover/end 同规则。"""
    from agent.agents.bidding_agent.schemas import SlideDraft
    SlideDraft(id="sec", title="技术方案", kind="section", bullets=[])  # 不抛错


def test_chart_layout_requires_chart_data():
    from pydantic import ValidationError
    import pytest
    from agent.agents.bidding_agent.schemas import SlideDraft
    with pytest.raises(ValidationError, match="chart 版式却没给 chart 数据"):
        SlideDraft(id="s1", title="团队构成", kind="content", layout="chart", bullets=[])


def test_chart_series_length_must_match_categories():
    """生产事故预防：categories 3 个、values 只给 2 个会让 python-pptx 渲染时数据错位或报错——
    在骨架校验阶段就拒绝，不要留到渲染层才炸。"""
    from pydantic import ValidationError
    import pytest
    from agent.agents.bidding_agent.schemas import SlideChart
    with pytest.raises(ValidationError, match="values 长度"):
        SlideChart(categories=["高级", "中级", "初级"], series=[{"name": "人数", "values": [3, 6]}])


def test_pie_chart_rejects_multiple_series():
    from pydantic import ValidationError
    import pytest
    from agent.agents.bidding_agent.schemas import SlideChart
    with pytest.raises(ValidationError, match="饼图"):
        SlideChart(type="pie", categories=["A", "B"],
                   series=[{"name": "s1", "values": [1, 2]}, {"name": "s2", "values": [3, 4]}])


def test_comparison_layout_requires_both_bullets_and_one_or_two_stats():
    from pydantic import ValidationError
    import pytest
    from agent.agents.bidding_agent.schemas import SlideDraft
    with pytest.raises(ValidationError, match="左栏 bullets 不能为空"):
        SlideDraft(id="s1", title="对比", kind="content", layout="comparison", bullets=[],
                   stats=[{"value": "72小时", "label": "提前完成"}])
    with pytest.raises(ValidationError, match="1-2 项"):
        SlideDraft(id="s2", title="对比", kind="content", layout="comparison", bullets=["差异点"],
                   stats=[{"value": "a", "label": "1"}, {"value": "b", "label": "2"}, {"value": "c", "label": "3"}])
    # 合法：左右都给，且 stats 在 1-2 项范围内 —— 不抛错
    SlideDraft(id="s3", title="对比", kind="content", layout="comparison", bullets=["差异点"],
               stats=[{"value": "72小时", "label": "提前完成"}])


def test_bullets_is_required_in_the_llm_tool_schema():
    """生产事故（2026-07-30，run 61e62f63）：模型连续 3 次提交的 14 页 deck 里 bullets 键出现 0 次，
    stats/chart 却每页都给——述标步整个失败。差异在工具 schema：bullets 有 default_factory
    → 落到 required 之外且无 description，模型看不到"这个字段必须给"；而其它节点承载内容的字段
    （ReadItem.title/value、RiskFinding.title/level）都是必填，从没出过这种空产出。
    bullets 本就被 _content_needs_substance 强制非空，schema 必填只是让模型看见这条既有要求。"""
    from langchain_core.utils.function_calling import convert_to_openai_tool

    tool, _ = make_submit_tool("submit_deck_draft", DeckDraft, "提交述标骨架")
    params = convert_to_openai_tool(tool)["function"]["parameters"]
    slide = params["properties"]["slides"]["items"]

    assert "bullets" in slide["required"], "bullets 必须在 required 里，否则模型会整页只给标题"
    # 承载内容的字段要有 description：模型读工具 schema 比读提示词更认真
    assert slide["properties"]["bullets"].get("description")
    assert slide["properties"]["scoring"].get("description")
