import asyncio
from agent.agents.bidding_agent.schemas import RiskReport
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "score": 78, "high": 1, "mid": 2, "passed": 9,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★不可偏离）",
               "advice": "补 ISO27001 证书并附商务标第四章，否则废标", "target_tab": "business", "target_id": "b4",
               "anchor_text": "ISO27001 认证证书复印件"}],
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
            "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：ISO27001 认证（★不可偏离）",
            "advice": "补证书并附商务标第四章", "target_tab": "business", "target_id": "b4",
            "anchor_text": "ISO27001 认证证书复印件"}
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


def test_items_at_different_locations_are_not_collapsed():
    """标题/建议撞车，但指向的位置不同——是两条不同的发现（同类问题在多处各出现一次），
    去重键分不开就会把它们错误地塌缩成一条，漏报剩下的那些位置。

    位置是唯一能分辨它们的东西：审查载荷里没有任何内部条款 id（见 RiskFinding 上的说明），
    模型能给的只有章（target_id）与章内锚点（anchor_text）。
    反向变异：把 target_id 或 anchor_text 从去重键里拿掉，本用例变红。"""
    r = RiskReport(score=80, items=[
        _item(target_id="t1"), _item(target_id="b2")], passed_items=[])
    assert len(r.items) == 2
    r = RiskReport(score=80, items=[
        _item(anchor_text="技术偏离表"), _item(anchor_text="商务偏离表")], passed_items=[])
    assert len(r.items) == 2


def test_identical_items_at_the_same_location_still_collapse():
    """位置也一样才是真重复——去重不能因为键里加了位置就整个失效。"""
    r = RiskReport(score=80, items=[
        _item(target_id="b4", anchor_text="资质证书"),
        _item(target_id="b4", anchor_text="资质证书")], passed_items=[])
    assert len(r.items) == 1


def test_many_star_clauses_missing_from_one_table_stay_separate_findings():
    """同一张偏离表里漏登的十条★条款：target_id 相同、anchor_text 同为表头行，
    只有 tender_ref（各自的招标依据）不同——十条必须各留一条。

    这是废标级漏报的形态：提示词第 7 条要求每条漏登的★条款各出一条发现，锚点说明又要求
    缺失类问题摘抄"邻近原文（如表头行）"，位置判据于是全部撞车。去重键少了内容级判据，
    十条就并成一条、漏报其余九条。
    断言写成**下界**：宁可多留噪音，也不许少一条真发现。
    反向变异：把 tender_ref 从去重键里拿掉，本用例立刻变红（10 → 1）。"""
    items = [_item(title="★条款未登入偏离表", advice="在偏离表中逐条登记",
                   target_id="t5", anchor_text="采购需求偏离表（附件5-1）",
                   tender_ref=f"对应：★技术要求{n}（★不可偏离）") for n in range(10)]
    r = RiskReport(score=40, items=items, passed_items=[])
    assert len(r.items) >= 10, f"十条漏登★条款塌缩成了 {len(r.items)} 条，其余全部漏报"
    assert r.high >= 10


def test_an_anchor_quoting_a_system_note_is_cleared_but_the_finding_survives():
    """锚点抄到我们自己的注记 → 清空锚点、**保留发现**。

    喂模型的章节文本里 <img> 已被换成「【系统注记·图片】」，模型照"摘抄邻近原文"抄了它；
    而落库的是未经处理的原始 HTML，前端拿这种锚点永远匹配不到，静默退化成跳章顶。
    清空只是退回章顶跳转，删掉整条发现却可能让用户带着一份要废标的标书去投。
    反向变异：去掉 _derive_counts 里对 anchor_text 的注记判定，本用例变红。"""
    from agent.parsing.types import SYSTEM_NOTE_PREFIX

    noted = _item(title="缺少法定代表人身份证明", advice="补身份证复印件并盖章",
                  anchor_text=f"{SYSTEM_NOTE_PREFIX}·图片】")
    r = RiskReport(score=60, items=[noted], passed_items=[])
    assert len(r.items) == 1, "发现被整条丢掉了——锚点脏不是删真发现的理由"
    assert r.items[0].anchor_text == ""
    assert r.items[0].title == "缺少法定代表人身份证明"


def test_clearing_dirty_anchors_does_not_collapse_two_findings():
    """清理锚点不许**制造**塌缩：两条发现各自抄了不同的注记，清空后位置判据会凭空撞车。
    去重用清空前的原值，两条都得留下（宁可留噪音，绝不删真发现）。
    反向变异：把去重键改回读清空后的 i.anchor_text，本用例变红（2 → 1）。"""
    from agent.parsing.types import SYSTEM_NOTE_PREFIX

    a = _item(anchor_text=f"{SYSTEM_NOTE_PREFIX}·图片识别 第1张】")
    b = _item(anchor_text=f"{SYSTEM_NOTE_PREFIX}·图片识别 第7张】")
    r = RiskReport(score=60, items=[a, b], passed_items=[])
    assert len(r.items) >= 2, "清空脏锚点顺带把两条发现并成了一条"
    assert [x.anchor_text for x in r.items] == ["", ""]


def test_a_real_anchor_is_never_touched():
    """误伤检验：正文里真摘出来的锚点原样保留（否则等于把定位功能整个关了）。"""
    r = RiskReport(score=60, items=[_item(anchor_text="采购需求偏离表（附件5-1）")], passed_items=[])
    assert r.items[0].anchor_text == "采购需求偏离表（附件5-1）"


def test_title_emptied_by_cleanup_is_dropped_not_shipped():
    """标题清洗前非空、清洗后变空——整个标题就是个内部 id，不是真发现。
    min_length 只挡清洗前的原值，挡不住这种；必须丢弃这一条，不能连累整份报告失败。"""
    r = RiskReport(score=80, items=[_item(title="（sec-8-c95）"), _item()], passed_items=[])
    assert len(r.items) == 1
    assert r.items[0].title == "缺少 ISO27001"


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

    base = dict(level="高风险", tone="destructive", title="缺 ISO27001", chapter_title="企业资质",
                tender_ref="对应：ISO27001 认证", advice="补证书", target_tab="business", target_id="b4")
    try:
        RiskFinding(**base)
    except ValidationError:
        pass
    else:
        raise AssertionError("anchor_text 缺席竟然通过了校验——弱模型会直接省略它")

    assert RiskFinding(**base, anchor_text="").anchor_text == ""
    assert RiskFinding(**base, anchor_text="采购需求偏离表（附件5-1）").anchor_text == "采购需求偏离表（附件5-1）"


def test_the_tool_schema_neither_asks_for_clause_ids_nor_shows_one():
    """工具 schema 随每次审查请求一起发给模型，里面**一个内部条款 id 都不许有**——
    不许有 clause_ids 这个字段，也不许在任何字段说明里举 sec-8-c95 这类样例。

    读标条目、提纲、构成清单在载荷里都已剥干净（见 RiskFinding 上的说明），schema 曾是整个
    请求里仅剩的内部编号样例；而本仓守则是"给模型看一个被禁格式的样例，本身就是在示范它"
    （test_clause_id_boundary.TestDeviationTable 同款）。禁令保留，样例不留。
    反向变异：把 clause_ids 字段或描述里的 sec-8-c95 加回去，本用例变红。"""
    import json
    import re

    tool, _ = make_submit_tool("submit_risk_report", RiskReport, "提交审查报告")
    from langchain_core.utils.function_calling import convert_to_openai_tool
    schema = convert_to_openai_tool(tool)
    text = json.dumps(schema, ensure_ascii=False)          # 发出去的是序列化后的全文
    assert "clause_ids" not in text, "工具 schema 全文里还有 clause_ids"
    assert not re.search(r"sec-\d+-c\d+", text), \
        f"工具 schema 全文里还有内部条款 id 样例：{re.findall(r'sec-[0-9]+-c[0-9]+', text)}"

    item = schema["function"]["parameters"]["properties"]["items"]["items"]  # RiskFinding 内联在数组项里
    assert "clause_ids" not in item["properties"]
    # 定位与出处口径还在：去重、前端跳转、导出报告都靠它们，摘 clause_ids 不能顺手带走
    assert {"target_id", "anchor_text", "tender_ref", "chapter_title"} <= set(item.get("required", []))


def test_chapter_title_and_tender_ref_are_required_but_may_be_empty():
    """「所在章节」与「风险出处」两列：必填、可空。

    必填——弱模型对"可选"的字段的做法是整个省略（2026-08-01 Qwen3.6-35B 实测），而这两个字段
    直接渲染成风险卡与导出 docx 的两列；一旦省略，报告说有问题却不说在哪。
    可空——确实对不上时给空串，好过逼模型编一个出处（那正是 tender_ref 描述收敛要治的病）。
    反向变异：把任一字段改回 default=""，本用例变红。"""
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import RiskFinding

    base = dict(level="高风险", tone="destructive", title="缺 ISO27001", advice="补证书",
                target_tab="business", target_id="b4", anchor_text="")
    for missing in ("chapter_title", "tender_ref"):
        kw = {k: v for k, v in
              dict(chapter_title="企业资质", tender_ref="对应：ISO27001 认证").items() if k != missing}
        try:
            RiskFinding(**base, **kw)
        except ValidationError:
            pass
        else:
            raise AssertionError(f"{missing} 缺席竟然通过了校验——弱模型会直接省略它")

    f = RiskFinding(**base, chapter_title="", tender_ref="")
    assert f.chapter_title == "" and f.tender_ref == ""


def test_tender_ref_description_bans_inventing_chapter_numbers():
    """出处只许照抄材料里出现过的名称。载荷里根本没有招标文件的章节号（slim_read 的白名单
    只留 project_meta/categories/scoring/risk_summary，doc_headings 不在其中），而这个字段
    直接印进风险卡与导出的 docx——描述里若还命令模型「写成"对应：第X章 xxx"」，它只能编，
    编出来的假出处会被当成权威引用展示给付费用户。
    反向变异：把"不得自造「第X章」"从描述里删掉，本用例变红。"""
    from agent.agents.bidding_agent.schemas import RiskFinding

    desc = RiskFinding.model_fields["tender_ref"].description
    assert "第X章" in desc and "不得自造" in desc
    assert "照抄" in desc                       # 正面指路：抄材料里有的名称
    assert "空字符串" in desc                   # 抄不到时的出路，而不是编一个
