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


def test_a_long_deck_must_use_more_than_one_layout():
    """DeepSeek v4 实测：14 页正文里 13 页是纯要点、一张图表都没有——内容量够了但通篇一个调子，
    评委翻到后面全是项目符号列表。提示词早写了「同一版式连续超 3 页视为偷懒」，但没人执行，
    等于没写。按正文页数成比例要求非要点版式，模型把该画图的一页改成 chart 即可满足。"""
    import pytest
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import DeckDraft

    def deck(n_content, n_varied):
        slides = [{"id": "c", "title": "封面", "kind": "cover", "bullets": []}]
        for i in range(n_content):
            varied = i < n_varied
            slides.append({
                "id": f"s{i}", "title": f"页{i}", "kind": "content", "bullets": ["要点"],
                **({"layout": "comparison", "stats": [{"value": "1", "label": "x"}]} if varied else {}),
            })
        return {"slides": slides}

    DeckDraft(**deck(5, 0))                    # 短 deck 不强求
    with pytest.raises(ValidationError, match="版式"):
        DeckDraft(**deck(6, 0))                # 6 页正文全要点 → 拒
    DeckDraft(**deck(6, 1))                    # 有 1 页非要点 → 过
    with pytest.raises(ValidationError, match="版式"):
        DeckDraft(**deck(12, 1))               # 12 页只有 1 页非要点 → 仍嫌单调
    DeckDraft(**deck(12, 2))                   # 2 页 → 过


def test_a_chart_whose_values_are_all_equal_is_not_a_chart():
    """DeepSeek v4 pro 实测：为满足「必须有非要点版式」硬凑出「多因素认证/端到端加密/应用级访问控制/
    审计日志」四项、值全是 1 的柱状图——四根一样高的柱子，信息量为零。
    这是上一条约束自己制造的逃逸路径：加约束就得同时堵住敷衍满足它的走法。
    判据很干净——所有数值相同（或只有一个类别）本质就不是「跨类别可比数字」。"""
    import pytest
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import SlideChart

    from agent.agents.bidding_agent.schemas import DeckDraft, DeckSpec

    def draft(cats, series):
        return {"slides": [{"id": "s1", "title": "图", "kind": "content", "layout": "chart",
                            "bullets": [], "chart": {"type": "column", "categories": cats, "series": series}}]}

    with pytest.raises(ValidationError, match="没有可比性"):
        DeckDraft(**draft(["多因素认证", "端到端加密", "应用级访问控制", "审计日志"],
                          [{"name": "支持能力", "values": [1, 1, 1, 1]}]))
    with pytest.raises(ValidationError, match="没有可比性"):
        DeckDraft(**draft(["唯一项"], [{"name": "占比", "values": [100]}]))
    DeckDraft(**draft(["硬件", "服务", "税金"], [{"name": "报价构成", "values": [62, 30, 8]}]))
    # 多系列：某一个系列内部有差异即可（招标要求 vs 我方承诺，可能其中一条持平）
    DeckDraft(**draft(["响应", "到场"],
                      [{"name": "要求", "values": [2, 2]}, {"name": "承诺", "values": [1, 8]}]))
    # 存量 deck 的退化图表照样能导出——这条拦在生成阶段，不能让老 PPT 变成永久导不出
    DeckSpec(title="存量", slides=[{"id": "s1", "title": "图", "kind": "content", "layout": "chart",
                                    "bullets": ["说明"],
                                    "chart": {"type": "column", "categories": ["A", "B"],
                                              "series": [{"name": "x", "values": [1, 1]}]}}])


def test_page_count_ceiling_is_deliberately_left_to_the_prompt():
    """页数上限**有意不做硬校验**。DeepSeek v4 pro 确实超了（15 分钟给 14 页正文），但做成硬校验后
    实测撞上「多条约束三轮收敛不了 → 整步失败退款、用户什么都拿不到」——多两页属于「不够好」，
    整步失败属于「不能用」，后者代价大得多。
    判据：只有「不拦就等于交付垃圾」的才配当校验器（缺 bullets、图表数据被丢弃属于此类）。
    本测试锁住这个决定，防止以后有人顺手又把它加回硬校验。"""
    from agent.agents.bidding_agent.schemas import DeckDraft
    slides = [{"id": "c", "title": "封面", "kind": "cover", "bullets": []}]
    for i in range(14):
        varied = i < 2
        slides.append({"id": f"s{i}", "title": f"页{i}", "kind": "content", "bullets": ["要点"],
                       **({"layout": "comparison", "stats": [{"value": "1", "label": "x"}]} if varied else {})})
    DeckDraft(duration=15, slides=slides)      # 超上限不拦，交给提示词引导


def test_outline_desc_is_marked_as_user_only_in_the_tool_schema():
    """desc 是用户在页面上手写的写作说明，写手把它当成「用户的明确要求、优先级高于自身判断」。
    它出现在 submit_outline 的工具 schema 里却没有任何说明时，模型会顺手填满每一项——
    等于把模型自己的话洗成用户指令，用户还会在编辑弹窗里看到一段自己没写过的文字。
    字段描述里必须明写「留空/由用户填写」，提示词里也有对应一条。"""
    from langchain_core.utils.function_calling import convert_to_openai_tool
    from agent.agents.bidding_agent.schemas import Outline
    from agent.framework.structured import make_submit_tool
    from agent.agents.bidding_agent.prompts.outline import OUTLINE_SYSTEM_PROMPT

    tool, _ = make_submit_tool("submit_outline", Outline, "提交提纲")
    item = convert_to_openai_tool(tool)["function"]["parameters"]["properties"]["chapters"]["items"]
    desc_field = item["properties"]["items"]["items"]["properties"]["desc"]
    assert "留空" in (desc_field.get("description") or ""), "desc 字段没告诉模型要留空"
    assert "desc" in OUTLINE_SYSTEM_PROMPT and "留空" in OUTLINE_SYSTEM_PROMPT
