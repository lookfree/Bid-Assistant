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


def test_layout_is_derived_from_the_payload_the_model_actually_sent():
    """生产事故（2026-07-30，step 41a13d7f）：模型给了 chart 数据和 stats 卡片，却没给 layout 键
    → pydantic 填上默认 "bullets" → 渲染层按 layout 分派，图表与数字卡片被静默丢弃，
    用户拿到一份"一个图表都没有"的 PPT，而数据其实好好躺在库里。
    与 bullets 同一类根因（有默认值、无描述的字段模型会跳过），但这里不能靠"改必填"解决：
    layout 漏填就整单拒会新增一种失败模式。数据本身才是可靠的意图证据——有 chart 就是图表页。"""
    from agent.agents.bidding_agent.schemas import Slide, SlideDraft

    chart = {"type": "column", "categories": ["一阶段", "二阶段"],
             "series": [{"name": "工期(天)", "values": [15, 30]}]}
    stats = [{"value": "8 小时", "label": "到场时限"}]

    # 渲染层的 Slide：存量 deck 重新导出时也要能纠正（用户已生成的那份就是这个形状）
    assert Slide(id="s1", title="进度", kind="content", bullets=["按期交付"], chart=chart).layout == "chart"
    assert Slide(id="s2", title="对比", kind="content", bullets=["差异"], stats=stats).layout == "comparison"
    # 骨架层的 SlideDraft：纠正必须发生在 _content_needs_substance 之前，否则 chart 页会被误判为缺 bullets
    assert SlideDraft(id="s3", title="进度", kind="content", bullets=[], chart=chart).layout == "chart"
    # 模型显式选了版式就不覆盖
    assert Slide(id="s4", title="要点", kind="content", layout="bullets", bullets=["纯要点"]).layout == "bullets"
    # 非 content 页不纠正（封面不会因为带了残留数据变成图表页）
    assert Slide(id="s5", title="封面", kind="cover", chart=chart).layout == "bullets"


def test_every_section_divider_needs_real_content_after_it():
    """用户实测：14 页里 5 页是纯标题分隔页，内容页只有 7 张——评委翻两页就撞见一张大蓝页。
    提示词早写了页数区间，模型照做了总页数却拿分隔页凑数，所以要在结构上兜一道：
    每张 section 后面必须跟至少 2 张 content 页，否则分隔页就是在灌水。"""
    import pytest
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import DeckDraft

    def deck(kinds):
        return {"slides": [
            {"id": f"s{i}", "title": f"页{i}", "kind": k, "bullets": ["要点"] if k == "content" else []}
            for i, k in enumerate(kinds)]}

    # 分隔页后面只有 1 张内容页 → 拒
    with pytest.raises(ValidationError, match="至少 2 张"):
        DeckDraft(**deck(["cover", "section", "content", "section", "content", "end"]))
    # 分隔页后面直接是结束页 → 拒（挂了个标题却什么都没讲）
    with pytest.raises(ValidationError, match="至少 2 张"):
        DeckDraft(**deck(["cover", "section", "content", "content", "section", "end"]))
    # 每张分隔页后 2 张以上内容页 → 通过
    DeckDraft(**deck(["cover", "section", "content", "content", "section", "content", "content", "end"]))
    # 没有分隔页的短 deck 不受影响
    DeckDraft(**deck(["cover", "content", "content", "end"]))


def test_chart_categories_must_share_one_unit_at_generation_time():
    """用户实测那张条形图：响应时限(h)=1、到场时限(h)=8、质保期(月)=36、巡检间隔(月)=6 画在同一根轴上，
    36 的柱子把 1 小时那根压成一条看不见的线——评委实际只看得到一项，另外三项白画。
    只在**生成阶段**（DeckDraft）拒，让模型拆成两张图或改用数字卡片；单位没标注就不管（无从判断）。"""
    import pytest
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import DeckDraft

    def draft(cats, vals):
        return {"slides": [{"id": "s1", "title": "图", "kind": "content", "layout": "chart", "bullets": [],
                            "chart": {"type": "bar", "categories": cats,
                                      "series": [{"name": "承诺", "values": vals}]}}]}

    with pytest.raises(ValidationError, match="单位"):
        DeckDraft(**draft(["响应时限(h)", "到场时限(h)", "质保期(月)", "巡检间隔(月)"], [1, 8, 36, 6]))
    DeckDraft(**draft(["响应时限(h)", "到场时限(h)"], [1, 8]))            # 同单位放行
    with pytest.raises(ValidationError, match="单位"):                    # 全角括号同样识别
        DeckDraft(**draft(["合同额（万元）", "项目数（个）"], [800, 12]))
    DeckDraft(**draft(["高级", "中级", "初级"], [3, 6, 4]))               # 没标注单位 → 不管


def test_stored_decks_with_mixed_units_still_render():
    """生产事故（2026-07-31）：单位检查放在 SlideChart 上，而 SlideChart 被 Slide 共用 →
    DeckSpec 一起收紧 → 库里已有的混单位图表**再也导不出来**（实测 /render/deck 500）。
    新规则只该拦住新生成的坏图，绝不能让存量 deck 变成永久导不出。"""
    from agent.agents.bidding_agent.schemas import DeckSpec
    deck = DeckSpec(title="存量", slides=[
        {"id": "s1", "title": "质保承诺", "kind": "content", "layout": "chart", "bullets": ["说明"],
         "chart": {"type": "bar", "categories": ["响应时限(h)", "质保期(月)"],
                   "series": [{"name": "承诺", "values": [1, 36]}]}},
    ])
    assert deck.slides[0].chart is not None
