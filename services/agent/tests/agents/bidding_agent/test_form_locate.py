"""全文表单定位（form_locate）：夹具**照抄 2026-08-12 云上江西那单的真实解析形状**——
整份采购公告挤在 sec-1、全部表单挤在 sec-2/sec-3、「1.响应函」挂在 sec-1 末尾、
「供应商情况一览表」无编号独占 sec-9 开头。就是这份文档把「条款所在节整节取」
打成了废标级事故（响应函章 = 公告转储），夹具造成规整形状等于什么都没测。"""
from agent.agents.bidding_agent.nodes.form_locate import (
    build_form_index, find_form, slice_single_form, _looks_like_form_title)


def _read() -> dict:
    """云上江西 .doc 解析结果的浓缩复刻：节的归属、边界行的位置、干扰行全部保真。"""
    sec1 = [  # 整份采购公告 + 格式章引导，最后一行是「1.响应函」（切分器把它留在上一节末尾）
        "采购方案", "一、项目概况",
        "根据已经审批通过的采购需求，拟对云上（江西）安全技术有限公司019采购零信任项目进行采购，资金来源为自筹。",
        "（六）初步评审表：",
        "序号\t项目\t审查因素\t评审标准",
        "2\t形式评审\t响应函\t符合响应文件格式要求",         # 表格行提到「响应函」，不得当边界
        "6\t形式评审\t法定代表人授权书\t符合响应文件格式要求",
        "2026年 06月17日",                                   # 年份行不是「第2026个表单」
        "响应文件格式", "响 应 文 件", "项目名称：", "供应商（签章）", "年   月   日",
        "1.响应函",
    ]
    sec2 = [  # 响应函正文 + 授权书 + 报价一览表 + 报价明细表，四份连体
        "致：【XX公司[采购人名称]】：",
        "（供应商名称）（以下称“我方”）已仔细研究了 （询比项目名称） 询比文件的全部内容。",
        "我方承诺如下内容：",
        "1.我方的响应文件包含询价文件规定的全部内容。",       # 表单内编号条款，不得当边界
        "8.如确定我方成交：",                                 # 短且无句号但带冒号，不得当边界
        "（1）我方承诺在收到成交通知书后，在成交通知书规定的期限内与你方签订合同。",
        "我方在此声明，所提交的响应文件及有关资料内容完整、真实和准确。",
        "供应商名称：", "日期： 年  月  日",
        "编制要求：除本文件允许供应商进行填写的内容以外，供应商不得对本文件进行修改。",
        "2.法定代表人授权书",
        "法定代表人授权书",                                   # 表单自己的标题行，不得把自己切死
        "致：云上（江西）安全技术有限公司",
        "（供应商全称）法定代表人           授权         （全权代表姓名）为全权代表。",
        "附：全权代表人和法定代表人身份证原件扫描件（正、反面）",
        "3.报价一览表",
        "序号\t项目名称\t数量\t单价（元）\t总价（元）\t税率",
        "合计（大写）：\t合计（大写）：",
        "3-1.报价明细表",                                     # 子编号：一览表的段要包含它
        "报价明细表",
        "序号\t产品名称\t品牌\t型号\t数量\t单价（元）\t总价（元）\t税率",
        "注：1.供应商必须填写分项报价，以证明报价的合理性，否则视为无效响应。",
    ]
    sec3 = [  # 资格文件章（节标题是「4.资格文件及资格信用承诺函」）
        "说明：1.以下应当提交的资格、资信证明文件均为原件扫描件。",
        "4-1.供应商资格信用承诺函",
        "供应商资格信用承诺函",
        "我单位(本人)自愿参加本次采购询价活动，严格遵守相关法律法规，并郑重承诺：",
        "（一）我单位(本人)符合采购文件要求以及具备本项目规定的资格条件：",
        "4-2要求的资格文件",                                  # 无点号编号行，也是边界
        "2.如供应商是企业的（包括合伙企业）应提供有效的“企业法人营业执照”或“营业执照”。",
    ]
    sec9 = [  # 供应商情况一览表：无编号表单名行 + 表格
        "供应商情况一览表",
        "注册地址\t\t\t\t邮政编码",
        "法定代表人\t姓名\t\t技术职称\t\t电话",
        "供应商签章",
    ]
    sections = []
    for sec, lines in (("sec-1", sec1), ("sec-2", sec2), ("sec-3", sec3), ("sec-9", sec9)):
        sections += [{"id": f"{sec}-c{i+1}", "text": t} for i, t in enumerate(lines)]
    headings = [{"sec": "sec-2", "level": 2, "title": "响   应   函"},
                {"sec": "sec-3", "level": 2, "title": "4.资格文件及资格信用承诺函"},
                {"sec": "sec-9", "level": 2, "title": "其他资料"}]
    return {"doc_sections": sections, "doc_headings": headings}


class TestFindForm:
    def test_response_letter_is_its_own_form_not_the_whole_notice(self):
        """响应函章只拿 1.响应函 那一份——**绝不含采购公告**。公告转储正是这次的事故。"""
        text = find_form(build_form_index(_read()), "第一章 响应函（技术标）")
        assert "致：【XX公司[采购人名称]】：" in text
        assert "编制要求" in text                      # 表单最后一行固定文字要在
        assert "采购方案" not in text                  # 公告一个字都不能进来
        assert "初步评审表" not in text
        assert "法定代表人授权书" not in text          # 下一份表单也不能进来

    def test_inner_numbered_clauses_do_not_split_the_form(self):
        """「1.我方的响应文件…」「8.如确定我方成交：」是表单内条款，不是边界——
        拿它们当边界，响应函会在第 8 条处被拦腰切断，声明与落款段全丢。"""
        text = find_form(build_form_index(_read()), "响应函")
        assert "我方在此声明" in text
        assert "供应商名称：" in text

    def test_composite_chapter_name_matches_by_part(self):
        """「法定代表人证明与授权书」按连接词拆部件后命中「法定代表人授权书」。"""
        text = find_form(build_form_index(_read()), "第二章 法定代表人证明与授权书（商务标）")
        assert "（供应商全称）法定代表人" in text
        assert "附：全权代表人和法定代表人身份证原件扫描件（正、反面）" in text
        assert "致：【XX公司" not in text               # 响应函不能混进来
        assert "报价一览表" not in text

    def test_form_own_title_line_stays_inside_its_segment(self):
        """「2.法定代表人授权书」下一行的同名标题行是表单的一部分，不是新边界。"""
        text = find_form(build_form_index(_read()), "法定代表人授权书")
        assert text.splitlines()[0] == "法定代表人授权书"

    def test_price_table_includes_its_sub_numbered_detail_table(self):
        """报价一览表（3.）的段包含报价明细表（3-1.）——一览与明细本就是一套。"""
        text = find_form(build_form_index(_read()), "第一章 报价一览表（商务标）")
        assert "序号\t项目名称\t数量" in text
        assert "报价明细表" in text
        assert "4-1" not in text                       # 到下一个同级边界为止

    def test_commitment_letter_prefers_the_deepest_match(self):
        """「承诺函与声明」同时命中「4.资格文件及资格信用承诺函」（整章标题）和
        「4-1.供应商资格信用承诺函」（那份表单）——必须取后者。"""
        text = find_form(build_form_index(_read()), "第六章 承诺函与声明（商务标）")
        assert "郑重承诺" in text
        assert text.splitlines()[0] == "供应商资格信用承诺函"
        assert "说明：1.以下应当提交的资格" not in text   # 整章开头的说明不属于这份表单

    def test_unnumbered_form_name_line_is_a_boundary(self):
        """「供应商情况一览表」无编号、独占一行——构词法收进索引，整段表格归它。"""
        text = find_form(build_form_index(_read()), "第四章 供应商情况一览表（商务标）")
        assert "注册地址" in text
        assert "供应商签章" in text

    def test_qualifier_mismatch_does_not_cross_match(self):
        """「供应商情况一览表」与「报价一览表」共享「一览表」三字——**不得互相错配**。"""
        idx = build_form_index(_read())
        assert "注册地址" not in find_form(idx, "报价一览表")
        assert "单价（元）" not in find_form(idx, "供应商情况一览表")

    def test_table_cell_mentions_are_not_boundaries(self):
        """初步评审表里「响应函」「法定代表人授权书」是表格单元格提及——带制表符的行
        绝不算边界，否则评审表每一行都会开一个假表单段。"""
        idx = build_form_index(_read())
        assert all("形式评审" not in s["name"] for s in idx)

    def test_unknown_form_returns_empty_never_the_notice(self):
        """对不上任何边界 → 空串（调用方走兜底/留痕），绝不退回整节公告凑数。"""
        assert find_form(build_form_index(_read()), "投标保证金保函") == ""

    def test_no_headings_no_boundaries_index_is_empty(self):
        assert build_form_index({"doc_sections": [
            {"id": "sec-1-c1", "text": "致招标人：我方郑重作出服务承诺并参加投标"}]}) == []


class TestSliceSingleForm:
    def test_single_form_text_passes_through(self):
        """读标登记的节里就一份表单（潍坊式细粒度）→ 原样可用。"""
        text = "致招标人：我方郑重作出服务承诺并参加投标"
        assert slice_single_form(text, "投标函") == text

    def test_multi_form_section_is_sliced_to_the_named_one(self):
        """节里装着好几份（云上江西式粗粒度）→ 只切出与本章同名的那份。"""
        text = "\n".join(["1.响应函", "致：采购人", "响应内容完整真实。",
                          "2.法定代表人授权书", "授权某某为全权代表。"])
        got = slice_single_form(text, "响应函")
        assert "致：采购人" in got and "授权某某" not in got

    def test_multi_form_section_with_no_match_returns_empty(self):
        """节里有边界但没有本章那份 → 空串。**宁可降级，也不把整节当模板下发**——
        这是这次事故的核心教训，这条断言变绿以前公告转储就是默认行为。"""
        text = "\n".join(["1.报价一览表", "序号\t数量", "2.授权书", "授权内容"])
        assert slice_single_form(text, "响应函") == ""


class TestReviewFindings0813:
    """2026-08-13 评审 CONFIRMED 项的钉子测试，夹具照抄评审复现。"""

    def test_main_form_beats_its_own_appendix(self):
        """「投标函」章同时命中「1.投标函」与「1-1.投标函附录」→ 必须要父段。
        取子项等于把整份投标函交付成一张附录表（评审复现）。"""
        read = {"doc_sections": [
            {"id": "sec-1-c1", "text": "1.投标函"},
            {"id": "sec-1-c2", "text": "致：招标人"},
            {"id": "sec-1-c3", "text": "我方愿意按招标文件规定承担全部义务。"},
            {"id": "sec-1-c4", "text": "1-1.投标函附录"},
            {"id": "sec-1-c5", "text": "序号\t条款名称\t约定内容"},
        ], "doc_headings": []}
        idx = build_form_index(read)
        for title in ("投标函", "投标函及投标函附录"):
            text = find_form(idx, title)
            assert "我方愿意按招标文件规定承担全部义务。" in text, f"{title}：正文被丢，只剩附录"
            assert "约定内容" in text                       # 附录本就在父段里
        # 专门要附录的章仍拿附录自己
        assert find_form(idx, "投标函附录").splitlines()[0] == "序号\t条款名称\t约定内容"

    def test_orphan_numbered_line_inside_a_form_is_not_a_boundary(self):
        """表单体内凭空出现的「3.售后服务承诺」（前面没有 1、2 号边界）不是边界——
        当边界会把报价函拦腰切断、尾部被保真机制钉死成"这就是全部"（评审复现）。"""
        text = "报价函\n致：招标人（名称）\n本报价函自开标之日起90天内有效。\n3.售后服务承诺\n我们郑重承诺提供三年质保服务"
        got = slice_single_form(text, "报价函")
        assert "我们郑重承诺提供三年质保服务" in got, "表单尾部被孤立编号行切掉了"

    def test_chained_numbered_boundary_still_terminates(self):
        """编号链上的「4-2要求的资格文件」（紧接 4-1）仍是真边界——4-1 的段不得吞掉 4-2。"""
        text = find_form(build_form_index(_read()), "承诺函与声明")
        assert "如供应商是企业的" not in text, "4-2 的内容混进了 4-1 的表单"

    def test_restarted_checklist_numbers_do_not_cut(self):
        """表单里从 1 重新数起的材料清单（1.营业执照 2.资质证书）接不上最近边界的编号，
        不是边界——否则资格文件段被清单切碎。"""
        read = {"doc_sections": [
            {"id": "sec-1-c1", "text": "1.资格声明函"},
            {"id": "sec-1-c2", "text": "我方声明符合下列条件并附材料："},
            {"id": "sec-1-c3", "text": "1.营业执照"},
            {"id": "sec-1-c4", "text": "2.资质证书"},
            {"id": "sec-1-c5", "text": "以上材料均加盖公章。"},
        ], "doc_headings": []}
        text = find_form(build_form_index(read), "资格声明函")
        assert "以上材料均加盖公章。" in text
        assert "2.资质证书" in text, "清单行被当成边界切走了"


def test_morphology_still_exported_for_content_node():
    """content.py 从这里引用构词法——搬迁不改行为（报价函在、技术偏离表不在）。"""
    assert _looks_like_form_title("报价函")
    assert _looks_like_form_title("投标函及投标函附录")
    assert not _looks_like_form_title("技术偏离表")
    assert not _looks_like_form_title("服务承诺")


class TestNodeSpans:
    """复印机 T2（spec 2026-08-14 form-xml-copier）：表单段落带出 body 节点区间，
    导出时按区间深拷贝招标 docx 的 XML。"""

    _READ = {"doc_sections": [
        {"id": "sec-8-c1", "text": "3.报价一览表", "src": 40},
        {"id": "sec-8-c2", "text": "序号\t项目名称\t数量\n合计（大写）：", "src": 41},  # 多行条款共号
        {"id": "sec-8-c3", "text": "3-1.报价明细表", "src": 42},
        {"id": "sec-8-c4", "text": "序号\t产品名称\t品牌\t数量", "src": 43},
        {"id": "sec-8-c5", "text": "4.资格文件", "src": 45},
        {"id": "sec-8-c6", "text": "按资格要求提供原件扫描件。", "src": 46},
    ], "doc_headings": []}

    def test_form_segment_carries_its_node_span(self):
        """内容区间不含边界编号行（「3-1.报价明细表」是目录式编号，segment_text 同样排除），
        编号行记在 head 上供去重截断。父段天然含子段内容。"""
        from agent.agents.bidding_agent.nodes.form_locate import (
            FormSpan, build_form_index, form_node_span)
        index = build_form_index(self._READ)
        assert form_node_span(index, "报价明细表") == FormSpan(43, 43, 42)
        assert form_node_span(index, "报价一览表") == FormSpan(41, 43, 40)

    def test_missing_src_returns_none(self):
        """旧读标结果没有 src（发版前入库的）→ 返回 None，复印机自然回退 HTML 路线。"""
        from agent.agents.bidding_agent.nodes.form_locate import build_form_index, form_node_span
        read = {"doc_sections": [{"id": "s-c1", "text": "3.报价一览表"},
                                 {"id": "s-c2", "text": "序号\t名称"}], "doc_headings": []}
        assert form_node_span(build_form_index(read), "报价一览表") is None

    def test_dedupe_spans_truncates_the_parent_before_a_claimed_child(self):
        """一览表(41-43) 含 明细表(43-43,head=42)：两章各自复印时父区间连子段的编号行
        一起截掉（与文本级 dedupe_nested 摘「前导编号行」同语义），不截明细表就重复一遍。"""
        from agent.agents.bidding_agent.nodes.form_locate import FormSpan, dedupe_spans
        spans = {"b1": FormSpan(41, 43, 40), "b2": FormSpan(43, 43, 42)}
        out = dedupe_spans(spans)
        assert out["b1"] == FormSpan(41, 41, 40)
        assert out["b2"] == FormSpan(43, 43, 42)

    def test_dedupe_spans_leaves_disjoint_spans_alone(self):
        from agent.agents.bidding_agent.nodes.form_locate import FormSpan, dedupe_spans
        spans = {"a": FormSpan(1, 5, 0), "b": FormSpan(7, 9, 6)}
        assert dedupe_spans(spans) == spans


class TestTrailingBoundaryTrim:
    def test_trailing_numbered_heading_is_trimmed_from_the_template(self):
        """b5 案二拒：局部切片里编号链未建立,「4-2要求的资格文件」邻节标题混进承诺函模板
        尾巴——模型如实不抄它反被判改写。segment_text 尾部剥编号边界行;表单裸抬头不剥。"""
        from agent.agents.bidding_agent.nodes.form_locate import segment_text
        seg = {"name": "供应商资格信用承诺函",
               "lines": ["供应商资格信用承诺函", "我单位郑重承诺守信经营。", "4-2要求的资格文件"],
               "srcs": [1, 2, 3]}
        text = segment_text(seg)
        assert "4-2要求的资格文件" not in text
        assert "供应商资格信用承诺函" in text and "郑重承诺" in text


class TestFoldedFormItems:
    """2026-08-15 fd5a6ced 实测：模型把「法定代表人授权书」折进响应函章当小节，
    表单章零模型路径按章名只取一份模板，折叠小节整体蒸发——菜单有、正文无。
    folded_form_items 是①提纲拆章与②零模型守约闸共用的判定源。"""

    def _chapters(self):
        return [
            {"id": "b1", "title": "响应函", "group": "business", "items": [
                {"id": "b1-1", "label": "一、响应函", "children": []},
                {"id": "b1-2", "label": "二、法定代表人授权书", "children": [
                    {"id": "b1-2-1", "label": "1. 法定代表人授权书正文（按格式填写）"},
                    {"id": "b1-2-2", "label": "2. 法定代表人及委托代理人身份证扫描件"}]},
                {"id": "b1-3", "label": "三、响应函格式符合性说明", "children": []}]},
            {"id": "b2", "title": "报价一览表", "group": "business", "items": [
                {"id": "b2-1", "label": "一、报价一览表", "children": []}]},
        ]

    def test_folded_authorization_letter_is_detected(self):
        from agent.agents.bidding_agent.nodes.form_locate import folded_form_items
        folded = folded_form_items(self._chapters(), build_form_index(_read()))
        assert [core for _, core in folded.get("b1", [])] == ["法定代表人授权书"]
        assert folded["b1"][0][0]["id"] == "b1-2"
        assert not folded.get("b2")           # 一览表章自己的 item 不算折叠

    def test_own_chapter_claims_the_segment_no_false_fold(self):
        """授权书已有独立章时，别章 items 里再提它只是交叉引用，不得拆重复章。"""
        from agent.agents.bidding_agent.nodes.form_locate import folded_form_items
        chs = self._chapters() + [{"id": "b7", "title": "法定代表人授权书",
                                   "group": "business", "items": []}]
        folded = folded_form_items(chs, build_form_index(_read()))
        assert not folded.get("b1")

    def test_folded_detail_table_inside_price_chapter_is_detected(self):
        """报价明细表（3-1 子表单）被折进一览表章 → 同样拆：招标构成里它是独立一份。"""
        from agent.agents.bidding_agent.nodes.form_locate import folded_form_items
        chs = self._chapters()
        chs[1]["items"].append({"id": "b2-2", "label": "二、报价明细表", "children": []})
        folded = folded_form_items(chs, build_form_index(_read()))
        assert [core for _, core in folded.get("b2", [])] == ["报价明细表"]

    def test_non_form_items_never_flag(self):
        """签章/日期/含税说明这类普通 item 与任何表单段都对不上，绝不误拆。"""
        from agent.agents.bidding_agent.nodes.form_locate import folded_form_items
        chs = [{"id": "t2", "title": "整体服务方案", "group": "tech", "items": [
            {"id": "t2-1", "label": "一、项目理解", "children": []},
            {"id": "t2-2", "label": "二、报价含税说明及税率标注", "children": []}]}]
        assert not any(folded_form_items(chs, build_form_index(_read())).values())

    def test_bare_leading_numeral_without_delimiter_is_not_an_ordinal(self):
        """评审 F2 CONFIRMED：「一次性告知承诺书」的「一」是词首不是序号——可选分隔符
        会把它剥成「次性告知承诺书」，拆出的章标题缺首字。裸数字后必须跟分隔符才剥。"""
        from agent.agents.bidding_agent.nodes.form_locate import _ORD_PREFIX
        assert _ORD_PREFIX.sub("", "一次性告知承诺书") == "一次性告知承诺书"
        assert _ORD_PREFIX.sub("", "二、法定代表人授权书") == "法定代表人授权书"
        assert _ORD_PREFIX.sub("", "1. 报价一览表") == "报价一览表"
        assert _ORD_PREFIX.sub("", "（一）响应函") == "响应函"
