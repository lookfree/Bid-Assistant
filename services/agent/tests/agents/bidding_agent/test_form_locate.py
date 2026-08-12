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


def test_morphology_still_exported_for_content_node():
    """content.py 从这里引用构词法——搬迁不改行为（报价函在、技术偏离表不在）。"""
    assert _looks_like_form_title("报价函")
    assert _looks_like_form_title("投标函及投标函附录")
    assert not _looks_like_form_title("技术偏离表")
    assert not _looks_like_form_title("服务承诺")
