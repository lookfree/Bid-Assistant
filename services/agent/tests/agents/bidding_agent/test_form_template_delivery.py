"""表单模板投递与保真接线（拆自 test_content_pipeline.py，2026-08-13 按 800 行文件规范分家）：
模板定位（按需投递/单份闸/父子去重/偏离表排除）与 form_fidelity 在流水线上的接线。"""
"""正文代码编排引擎（任务 #84）。

2026-08-08 一个下午没能完整交付一份标书，全部事故同一个根：编排权在模型手里。
这里守的是新引擎的编排不变式——章清单来自提纲、并发受限、每章落断点、残章重试、
缺章如实缺而不是整步崩。
"""
import asyncio

import pytest
from langchain_core.messages import AIMessage

from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline
from agent.config import settings

from agents.bidding_agent.pipeline_testkit import (
    _FakeChat, _FakeRedis, _brief_of, _ctx, _run, _state)


class TestBriefTargeting:
    """按需注入：偏离表条目只发给偏离表章、招标格式模板只发给被点名的格式章——
    整轮全量重发正是旧引擎 36:1 输入比的来源（#85 删旧引擎时从 test_content_node 移植）。"""

    def _state_with_deviation(self):
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "技术偏离表"
        state["read"] = {"categories": [
            {"key": "technical", "title": "技术", "items": [
                {"title": "最高限价", "value": "96万元", "star": True, "clause_ids": ["sec-19-c129"]}]}],
            "doc_headings": [{"sec": "sec-19", "title": "第五章 技术规范书", "level": 1}]}
        return state

    def test_deviation_items_go_only_to_the_deviation_chapter(self, monkeypatch):
        chat = _FakeChat()
        _run(self._state_with_deviation(), chat, monkeypatch=monkeypatch)
        dev = _brief_of(chat, "技术偏离表")
        other = _brief_of(chat, "章节2")
        assert "偏离表指引" in dev and "最高限价" in dev
        assert "偏离表指引" not in other, "偏离表全量条目发给了无关章——重蹈整轮重发"

    def test_no_internal_clause_id_reaches_any_brief(self, monkeypatch):
        """内部条款 id（sec-N-cM）只在提纲步进出模型，其余步喂之前剥掉——模型看得见就会写进
        交付文档（2026-08-08 用户截图：偏离表整列 sec-19-c129）。逐章简报同样守这条边界。"""
        import re
        chat = _FakeChat()
        _run(self._state_with_deviation(), chat, monkeypatch=monkeypatch)
        for _, user in chat.seen:
            assert not re.search(r"sec-\d+-c\d+", user), f"简报里泄漏了内部条款 id：{user[:200]}"
        assert "第五章 技术规范书" in _brief_of(chat, "技术偏离表")   # 出处列有真数据可填

    def test_tender_template_goes_only_to_the_named_form_chapter(self, monkeypatch):
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "投标函格式"
        state["outline"]["chapters"][0]["structure_ref"] = "s1"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "投标函", "clause_ids": ["sec-8-c1"]}]
        state["read"] = {"required_structure": [{"id": "s1", "title": "投标函", "kind": "form",
                                                 "clause_ids": ["sec-8-c1"]}],
                         "doc_sections": [{"id": "sec-8-c1", "text": "致：（招标人名称）我方参加贵方组织的投标"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "招标格式模板" in _brief_of(chat, "投标函格式")
        assert "招标格式模板" not in _brief_of(chat, "章节2"), "格式模板发给了无关章"

    def test_a_form_chapter_gets_the_template_even_if_nobody_listed_its_name(self, monkeypatch):
        """表单章的识别不能靠穷举词表。「报价函」曾不在表里（表里只有响应函/投标函/承诺函/
        报价表），于是整章拿不到招标格式原文，模型只能自己编——用户实测:招标 7 条固定条款
        被写成 6 条全新措辞，抬头、开场白、落款全变（2026-08-11 潍坊那单）。
        这里刻意**不给 structure_ref**，只靠标题走构词法判定。
        夹具按 2026-08-13 拉到的潍坊真实数据补全：表单文本自带「（一）报价函」编号行
        ——items 引用的「无边界=整段直取」直通道已封（它把整段磋商须知当过模板），
        真表单靠这行边界从全文索引召回。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第一章 报价函（商务标）"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "i1", "label": "一、报价函", "clause_ids": ["sec-8-c1"]}]
        state["read"] = {"doc_sections": [
            {"id": "sec-8-c1", "text": "（一）报价函\n潍坊环境工程职业学院：\n1、根据已收到的项目编号____的采购项目"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第一章 报价函（商务标）")
        assert "招标格式模板" in brief, "报价函章没拿到招标格式原文"
        assert "潍坊环境工程职业学院：" in brief, "模板原文没进简报"

    def test_coarse_section_never_ships_the_notice_as_a_template(self, monkeypatch):
        """2026-08-12 云上江西的事故本体：.doc 里表单名没做成标题样式，整份采购公告挤在
        一个 sec、全部表单挤在另一个 sec；章 items 的 clause_ids 是**需求条款引用**，
        指向公告那个 sec——「整节取」就把整份公告当成响应函模板逐字下发，再被保真机制
        钉死，交付的每个表单章都是公告转储。修后：整节文本要过单份闸，只有切得出
        「本章那一份」才算命中，公告一个字都不许进表单章的简报。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第一章 响应函（技术标）"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "i1", "label": "响应承诺", "clause_ids": ["sec-1-c1", "sec-1-c2"]}]
        state["read"] = {"doc_sections": [
            # sec-1 = 公告 + 格式章引导，「1.响应函」挂在节尾（切分器把它留在上一节）
            {"id": "sec-1-c1", "text": "采购方案"},
            {"id": "sec-1-c2", "text": "（三）本项目设置最高限价，最高限价为含税人民币230000元。"},
            {"id": "sec-1-c3", "text": "1.响应函"},
            # sec-2 = 响应函正文 + 下一份表单
            {"id": "sec-2-c1", "text": "致：【XX公司[采购人名称]】："},
            {"id": "sec-2-c2", "text": "我方将严格按照询比文件要求提交符合要求的全部响应文件。"},
            {"id": "sec-2-c3", "text": "2.法定代表人授权书"},
            {"id": "sec-2-c4", "text": "（供应商全称）法定代表人授权（全权代表姓名）为全权代表。"},
        ], "doc_headings": [{"sec": "sec-2", "level": 2, "title": "响   应   函"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第一章 响应函（技术标）")
        assert "致：【XX公司[采购人名称]】：" in brief, "没按边界切出响应函那一份"
        assert "采购方案" not in brief, "整份公告被当成模板下发——事故复现"
        assert "最高限价" not in brief
        # 盯下一份表单的**正文**：表单名会出现在 TEMPLATE_GUIDE 的示例文字里，盯名字必误报
        assert "（供应商全称）法定代表人授权（全权代表姓名）" not in brief, "下一份表单混进了响应函的模板"

    def test_clause_secs_feed_the_slicer_in_document_order(self, monkeypatch):
        """章引用横跨 sec-2 与 sec-10 时必须按**文档序**拼文本——字典序把 sec-10 排到
        sec-2 前面，单份闸的切割器按行序开闭段，边界之前的行会被当成"表单外"丢掉
        （评审 2026-08-13：正文尾行在边界行之前出现 → 不进段）。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "投标函"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "i1", "label": "投标函", "clause_ids": ["sec-10-c1", "sec-2-c1"]}]
        state["read"] = {"doc_sections": [
            {"id": "sec-2-c1", "text": "1.投标函"},
            {"id": "sec-2-c2", "text": "致：采购人"},
            {"id": "sec-10-c1", "text": "我方愿意承担招标文件规定的全部义务。"},
        ]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "投标函")
        assert "我方愿意承担招标文件规定的全部义务。" in brief, "sec-10 的正文行排到边界前被丢了"
        assert "致：采购人" in brief

    def test_deviation_chapter_never_gets_a_form_template(self, monkeypatch):
        """偏离表章绝不走模板保真——它有「偏离表指引+条目数据」通路，产出本该是填满响应的表。
        读标把它登记成 kind=form 时 struct 路曾绕过构词法：保真把模型**填好的**偏离表判成
        "改写模板"，打回招标的空表头（2026-08-13 云上重跑实测：偏离表章只剩 197 字空壳）。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "技术需求/服务偏离表", "structure_ref": "s7"})
        state["read"] = {
            "required_structure": [{"id": "s7", "title": "技术需求/服务偏离表", "kind": "form",
                                    "clause_ids": ["sec-7-c1"]}],
            "categories": [{"key": "technical", "title": "技术", "items": [
                {"title": "零信任网关吞吐量", "value": "10Gbps", "star": True, "clause_ids": ["sec-7-c1"]}]}],
            "doc_sections": [{"id": "sec-7-c1", "text": "5.技术需求/服务偏离表"},
                             {"id": "sec-7-c2", "text": "序号\t条目号\t需求\t响应\t偏离\t说明"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "技术需求/服务偏离表")
        assert "偏离表指引" in brief, "偏离章丢了自己的指引通路"
        assert "招标格式模板" not in brief, "偏离章收到了模板保真指令——填好的表会被打回空表"

    def test_detail_table_claimed_by_its_own_chapter_leaves_the_parent(self, monkeypatch):
        """提纲把报价一览表与报价明细表各立一章时，一览表章不再连带明细表——否则明细表
        在标书里出现两遍（2026-08-13 云上重跑实测）。单章场景父段含子段的行为不变
        （test_price_table_includes_its_sub_numbered_detail_table 钉着）。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "报价一览表", "items": []})
        state["outline"]["chapters"][1].update({"title": "报价明细表", "items": []})
        state["read"] = {"doc_sections": [
            {"id": "sec-2-c1", "text": "3.报价一览表"},
            {"id": "sec-2-c2", "text": "序号\t项目名称\t数量\t单价（元）\t总价（元）\t税率"},
            {"id": "sec-2-c3", "text": "合计（大写）：\t合计（大写）："},
            {"id": "sec-2-c4", "text": "注：报价一次性有效，包含运输、安装、调试与税费等全部费用。"},
            {"id": "sec-2-c5", "text": "3-1.报价明细表"},
            {"id": "sec-2-c6", "text": "报价明细表"},
            {"id": "sec-2-c7", "text": "序号\t产品名称\t品牌\t型号\t数量\t单价（元）\t总价（元）\t税率"},
            {"id": "sec-2-c8", "text": "注：供应商必须填写分项报价，以证明报价的合理性，否则视为无效响应。"},
            {"id": "sec-2-c9", "text": "4.资格文件"},
        ]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        parent = _brief_of(chat, "报价一览表")
        child = _brief_of(chat, "报价明细表")
        assert "序号\t项目名称" in parent and "品牌" not in parent, "一览表章还连带着明细表"
        assert "分项报价" not in parent, "子块只摘走一半"
        assert "品牌" in child, "明细表章没拿到自己的表"

    def test_template_falls_back_to_matching_by_heading_when_clause_ids_miss(self, monkeypatch):
        """降级一:条款 id 定位不到就按**标题**找。条款编号靠读标切分,切歪整章就零模板——
        而招标与投标两侧对同一份表单的叫法通常一致(都叫「报价函」),标题比编号稳。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第一章 报价函"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "报价函"}]  # 无 clause_ids
        state["read"] = {
            "doc_headings": [{"sec": "sec-8", "title": "附件一 报价函", "level": 2}],
            "doc_sections": [{"id": "sec-8-c1", "text": "致：潍坊环境工程职业学院\n1、我方同意本报价函自开标之日起有效"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第一章 报价函")
        assert "我方同意本报价函自开标之日起有效" in brief, "条款 id 落空后没按标题兜到模板"
        assert "招标格式模板" not in _brief_of(chat, "章节2"), "兜底把模板漏给了无关章"

    def test_template_falls_back_to_the_whole_format_chapter(self, monkeypatch):
        """降级二:条款 id 和标题都定位不到,就把招标的「格式」章整章给它。
        **宁可多给几千字让模型自己挑,也不能一个字不给**——给零它只会自创一份格式。"""
        state = _state(2)
        # 名字在招标标题里找不到（招标叫「格式二 开标一览表」，投标这章叫「投标承诺书」），
        # 前两条路都落空 → 必须走整章兜底
        state["outline"]["chapters"][0]["title"] = "投标承诺书"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "承诺事项"}]
        # 切分器每遇一个标题就另起一个 sec：章标题那个 sec 里**只有一句导语**，
        # 真正的表单在下级标题的 sec 里。只取命中的 sec 等于兜了个空（评审 2026-08-12 实证）。
        state["read"] = {
            "doc_headings": [
                {"sec": "sec-9", "title": "第四章 响应文件相关格式", "level": 1},
                {"sec": "sec-10", "title": "格式一 报价函", "level": 2},
                {"sec": "sec-11", "title": "格式二 开标一览表", "level": 2},
                {"sec": "sec-12", "title": "第五章 技术规范书", "level": 1},   # 同级 → 格式章到此为止
                {"sec": "sec-13", "title": "5.1 性能指标", "level": 2},
            ],
            "doc_sections": [
                {"id": "sec-9-c1", "text": "投标人应按下列格式编制响应文件。"},
                {"id": "sec-10-c1", "text": "致：招标人（报价函正文）"},
                {"id": "sec-11-c1", "text": "开标一览表（此处为招标规定表样）"},
                {"id": "sec-12-c1", "text": "本章为技术规范，与格式无关"},
                {"id": "sec-13-c1", "text": "吞吐量不低于 10Gbps"},
            ]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "投标承诺书")
        assert "此处为招标规定表样" in brief, "格式章整章兜底没生效——该章拿到了零模板"
        assert "报价函正文" in brief, "只捞到章导语,漏了下级标题里的模板本体"
        assert "吞吐量不低于 10Gbps" not in brief, "越过同级标题，把技术规范章也卷进来了"

    def test_a_form_chapter_with_no_template_anywhere_is_told_to_flag_it(self, monkeypatch):
        """三条路都空时**留痕**:让模型显式提示「未找到规定格式」。
        不声不响自创一份最危险——用户以为是照招标格式写的,评标时才发现对不上。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "法人授权委托书", "structure_ref": "s1"})
        state["read"] = {"required_structure": [{"id": "s1", "title": "法人授权委托书", "kind": "form"}],
                         "doc_sections": [{"id": "sec-8-c1", "text": "与格式无关的技术要求正文"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "法人授权委托书")
        assert "未能找到" in brief and "人工比对" in brief, "无模板时没留痕,模型会静默自创格式"
        assert "招标格式模板" not in brief, (
            "留痕不许带 TEMPLATE_GUIDE：那段开头说「以下为招标自带的格式模板原文」,"
            "后面却跟着「没找到原文」,十几行「务必照抄」配一份不存在的模板=请模型编一份")

    def test_a_guessed_form_chapter_with_no_template_stays_silent(self, monkeypatch):
        """构词法只是**猜**。猜错时那句「未找到本表单的规定格式」会原样印进交付的 docx,
        出现在一个根本不是表单的章开头（评审 2026-08-12）。只有读标登记成 form 才留痕。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "服务承诺书"   # 构词法命中,但读标没登记
        state["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": "与格式无关的技术要求正文"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "未能找到" not in _brief_of(chat, "服务承诺书")

    def test_deviation_and_volume_chapters_are_not_forms(self, monkeypatch):
        """只看后缀「表」「书」会把偏离表/标书判成表单:偏离表会同时收到偏离表指引与格式模板
        两份互相打架的指令,技术标书则会收到整章无关的格式原文（评审 2026-08-12 实证）。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "技术偏离表"
        state["outline"]["chapters"][1]["title"] = "技术标书"
        state["read"] = {
            "doc_headings": [{"sec": "sec-9", "title": "第四章 响应文件相关格式", "level": 1}],
            "doc_sections": [{"id": "sec-9-c1", "text": "投标人应按下列格式编制响应文件。"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "招标格式模板" not in _brief_of(chat, "技术偏离表")
        assert "招标格式模板" not in _brief_of(chat, "技术标书")

    def test_a_form_chapter_with_a_trailing_tail_still_counts(self, monkeypatch):
        """表单章常带尾巴:「投标函及投标函附录」只看结尾会漏判——旧的子串匹配本来是中的,
        这是改构词法时引入的回归（评审 2026-08-12 实证）。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "投标函及投标函附录"
        state["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "投标函", "clause_ids": ["sec-8-c1"]}]
        # 表单文本自带抬头行（真实形态，2026-08-13 潍坊数据实证）——items 的整段直通道已封
        state["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": "投标函\n致：招标人，我方决定参加投标"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "我方决定参加投标" in _brief_of(chat, "投标函及投标函附录")

    def test_a_two_character_form_name_is_not_used_to_search_headings(self, monkeypatch):
        """按标题检索要设最短名。「证明」两个字会把「资质证明材料」「业绩证明」全捞进来，
        几千字无关原文顶着「本章的招标格式原文」发出去，模型照单全抄（评审 2026-08-12）。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "第三章 证明"
        state["read"] = {
            "doc_headings": [{"sec": "sec-9", "title": "资质证明材料", "level": 2},
                             {"sec": "sec-10", "title": "业绩证明", "level": 2}],
            "doc_sections": [{"id": "sec-9-c1", "text": "投标人须提供近三年审计报告等资质材料"},
                             {"id": "sec-10-c1", "text": "近三年同类项目业绩清单及合同复印件"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "第三章 证明")
        assert "近三年审计报告" not in brief and "合同复印件" not in brief

    def test_a_prose_chapter_is_not_mistaken_for_a_form(self, monkeypatch):
        """构词法不能宽到把正文章也当表单——那会把无关的招标原文塞进技术方案章。"""
        state = _state(2)
        state["outline"]["chapters"][0]["title"] = "技术方案"
        state["outline"]["chapters"][0]["items"] = [
            {"id": "i1", "label": "总体设计", "clause_ids": ["sec-8-c1"]}]
        state["outline"]["chapters"][1]["title"] = "服务承诺"   # 以「承诺」收尾但是散文章
        state["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": "致：（招标人名称）"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "招标格式模板" not in _brief_of(chat, "技术方案")
        assert "招标格式模板" not in _brief_of(chat, "服务承诺")


class TestFormFidelity:
    """表单章保真接线：模型改写模板 → 弃用产出、拿招标原文渲染（判定逻辑本身见
    test_form_fidelity.py，这里只管**有没有真接上流水线**）。"""

    _TPL = ("报价函\n致：潍坊环境工程职业学院\n"
            "1、我方同意本报价函自开标之日起 90 天内有效，并承诺不作任何保留。\n"
            "2、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。")

    def _state(self):
        st = _state(2)
        st["outline"]["chapters"][0]["title"] = "报价函"
        st["outline"]["chapters"][0]["items"] = [{"id": "i1", "label": "报价函", "clause_ids": ["sec-8-c1"]}]
        st["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": self._TPL}]}
        return st

    def test_a_rewritten_form_is_replaced_by_the_tender_original(self, monkeypatch):
        """用户实测的原病：招标固定条款被换成全新措辞。提示词拦不住，代码必须拦住。"""
        class _Rewriter(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                if "报价函" in msgs[-1].content.split("请撰写本章")[-1]:
                    return AIMessage(content="<h3>报价函</h3><p>本报价函有效期为九十日，"
                                             + "我方保留最终解释权。" * 20 + "</p>")
                return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")

        chat = _Rewriter()
        out = _run(self._state(), chat, monkeypatch=monkeypatch)
        html = out["t1"]
        assert "保留最终解释权" not in html, "改写稿被原样交付了——保真校验没接上"
        assert "自开标之日起 90 天内有效" in html, "退路没拿招标原文渲染"

    def test_a_faithful_fill_is_kept(self, monkeypatch):
        """只填空、没改原文的产出必须原样留下——否则等于把模型的活白干了。"""
        class _Filler(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                if "报价函" in msgs[-1].content.split("请撰写本章")[-1]:
                    return AIMessage(content=(
                        "<h3>报价函</h3><p>致：潍坊环境工程职业学院</p>"
                        "<p>1、我方同意本报价函自开标之日起 90 天内有效，并承诺不作任何保留。</p>"
                        "<p>2、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</p>"
                        "<p>投标人：上海安几科技有限公司（盖章）</p>" + "<p>补充说明。</p>" * 20))
                return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")

        chat = _Filler()
        out = _run(self._state(), chat, monkeypatch=monkeypatch)
        assert "上海安几科技有限公司" in out["t1"]

    def test_the_whole_format_chapter_fallback_does_not_police_a_single_form(self, monkeypatch):
        """降级二给的是整份格式章（报价函+授权书+声明函…），而模型**正确的做法是只写其中一份**。
        拿整章去逐字校验，单份表单必然判不过 → 每个表单章都被换成整份格式章的转储，
        同一份格式章在标书里重复 N 遍、一个填好的表单都没有（2026-08-12 评审实证）。"""
        st = _state(2)
        st["outline"]["chapters"][0]["title"] = "投标承诺书"      # 名字在招标标题里找不到 → 走降级二
        st["read"] = {
            "doc_headings": [{"sec": "sec-9", "title": "第四章 响应文件相关格式", "level": 1},
                             {"sec": "sec-10", "title": "格式一 报价函", "level": 2}],
            "doc_sections": [{"id": "sec-9-c1", "text": "投标人应按下列格式编制响应文件。"},
                             {"id": "sec-10-c1", "text": "致：招标人，我方决定参加本项目的投标，并承诺遵守全部要求。"}]}

        class _OneForm(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                if "投标承诺书" in msgs[-1].content.split("请撰写本章")[-1]:
                    return AIMessage(content="<h3>投标承诺书</h3><p>我方郑重承诺遵守招标文件全部要求。</p>"
                                             + "<p>补充承诺条款。</p>" * 20)
                return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")

        out = _run(st, _OneForm(), monkeypatch=monkeypatch)
        assert "我方郑重承诺遵守招标文件全部要求" in out["t1"], "只写一份表单的正确产出被整章比对判死了"
        assert "投标人应按下列格式编制响应文件" not in out["t1"], "整份格式章被当成本章内容转储了"

    def test_the_fallback_never_ships_the_truncation_marker(self, monkeypatch):
        """raw 只用于校验与零模型渲染，带上「…（超长截断）」会把这个内部标记原样印进交付的
        docx（本仓已为同类泄漏返工过一次，任务 #96）。"""
        long_form = "报价函\n" + "\n".join(f"{i}、我方承诺遵守招标文件的第{i}项全部要求。" for i in range(1, 400))
        st = self._state()
        st["read"] = {"doc_sections": [{"id": "sec-8-c1", "text": long_form}]}

        class _Rewriter(_FakeChat):
            async def ainvoke(self, msgs, config=None):
                self.calls += 1
                self.seen.append((msgs[0].content, msgs[-1].content))
                return AIMessage(content="<h3>报价函</h3>" + "<p>我方另起炉灶写了一份。</p>" * 30)

        out = _run(st, _Rewriter(), monkeypatch=monkeypatch)
        assert "超长截断" not in out["t1"], "内部截断标记被印进交付内容"
        assert "我方承诺遵守招标文件的第399项全部要求" in out["t1"], "退路用的是被截断的模板"

    def test_bidder_info_reaches_only_the_form_chapter(self, monkeypatch):
        """单位名称/信用代码/法定代表人是**表单空位**要填的东西。散文章用不上，
        发过去只是白占本来就紧的单章预算。"""
        st = self._state()
        st["run_input"] = {"library_refs": {"company": [
            {"title": "企业信息", "fields": [{"label": "单位名称", "value": "上海安几科技有限公司"}]}]}}
        chat = _FakeChat()
        _run(st, chat, monkeypatch=monkeypatch)
        assert "上海安几科技有限公司" in _brief_of(chat, "报价函"), "表单章没拿到投标人信息"
        assert "上海安几科技有限公司" not in _brief_of(chat, "章节2"), "投标人信息发给了散文章"

    def test_no_company_entry_leaves_the_brief_untouched(self, monkeypatch):
        """没录企业信息的用户，简报里不该凭空多出一个空段落。"""
        chat = _FakeChat()
        _run(self._state(), chat, monkeypatch=monkeypatch)
        assert "【投标人信息】" not in _brief_of(chat, "报价函")

    def test_a_form_chapter_is_never_padded_to_hit_the_word_budget(self, monkeypatch):
        """给报价函注水凑字数本身就是改格式；扩写还是整章替换，一扩必然改写模板原文，
        等于自己把保真校验逼到必然退回空表。"""
        from agent.agents.bidding_agent.nodes import content_pipeline as cp

        expanded: list[str] = []

        async def _record(ctx, chat, sp, ch, user, html, budget, sem, progress):
            expanded.append(ch.get("id") or "")
            return html

        monkeypatch.setattr(cp, "_expand_short", _record)
        st = self._state()
        st["run_input"] = {"target_chars": 60000}      # 逼出很大的篇幅预算
        _run(st, _FakeChat(), monkeypatch=monkeypatch)
        assert "t1" not in expanded, "表单章被拿去扩写了"
        assert "t2" in expanded, "普通章的扩写被顺手关掉了——这条守的是「只豁免表单章」"


def test_deviation_reaches_structure_ref_marked_chapter(monkeypatch):
    """靠 structure_ref 识别的偏离章（标题不含「偏离」）也必须拿到条目数据——
    评审 2026-08-08：造数据认两条判定、发数据只认标题,这类章拿到零条目。"""
    state = _state(2)
    state["outline"]["chapters"][0]["title"] = "响应清单"
    state["outline"]["chapters"][0]["structure_ref"] = "s2"
    state["read"] = {"required_structure": [{"id": "s2", "title": "商务偏离表"}],
                     "categories": [{"key": "commercial", "title": "商务", "items": [
                         {"title": "交付周期", "value": "90天", "star": True, "clause_ids": ["sec-3-c1"]}]}]}
    chat = _FakeChat()
    _run(state, chat, monkeypatch=monkeypatch)
    assert "偏离表指引" in _brief_of(chat, "响应清单")
    assert "偏离表指引" not in _brief_of(chat, "章节2")


def test_template_does_not_overmatch_by_title_substring(monkeypatch):
    """散文章标题恰好出现在别章模板原文里,不得错收模板——评审 2026-08-08:旧的子串匹配
    会让「服务承诺」章收到 30k 无关表单并当格式文书来写。"""
    state = _state(2)
    state["outline"]["chapters"][0].update({"title": "投标函格式", "structure_ref": "s1",
                                            "items": [{"id": "i1", "label": "投标函", "clause_ids": ["sec-8-c1"]}]})
    state["outline"]["chapters"][1]["title"] = "服务承诺"
    state["read"] = {"required_structure": [{"id": "s1", "title": "投标函", "kind": "form",
                                             "clause_ids": ["sec-8-c1"]}],
                     "doc_sections": [{"id": "sec-8-c1", "text": "致招标人：我方郑重作出服务承诺并参加投标"}]}
    chat = _FakeChat()
    _run(state, chat, monkeypatch=monkeypatch)
    assert "招标格式模板" in _brief_of(chat, "投标函格式")
    assert "招标格式模板" not in _brief_of(chat, "服务承诺"), "标题子串误配——散文章收到了表单模板"


class TestReviewFindings0813Round3:
    """第三轮评审 CONFIRMED 项的钉子（夹具照抄评审复现）。"""

    def _price_read(self, extra=None):
        secs = [
            {"id": "sec-2-c1", "text": "3.报价一览表"},
            {"id": "sec-2-c2", "text": "序号\t项目名称\t数量\t单价（元）\t总价（元）\t税率"},
            {"id": "sec-2-c3", "text": "注：报价一次性有效，包含运输、安装、调试与税费等全部费用。"},
            {"id": "sec-2-c4", "text": "3-1.报价明细表"},
            {"id": "sec-2-c5", "text": "报价明细表"},
            {"id": "sec-2-c6", "text": "序号\t产品名称\t品牌\t型号\t数量\t单价（元）\t总价（元）\t税率"},
            {"id": "sec-2-c7", "text": "注：供应商必须填写分项报价，以证明报价的合理性，否则视为无效响应。"},
        ] + (extra or [])
        return {"doc_sections": secs, "doc_headings": []}

    def test_struct_path_parent_also_gets_deduped(self, monkeypatch):
        """①读标把一览表登记成构成项（struct 路命中）时，父段同样要被摘掉别章认领的
        明细表——去重只盖 find_form 路的话，这条常见路径上重复交付原样复发（评审复现）。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "报价一览表", "structure_ref": "s3", "items": []})
        state["outline"]["chapters"][1].update({"title": "报价明细表", "items": []})
        read = self._price_read()
        read["required_structure"] = [{"id": "s3", "title": "报价一览表", "kind": "form",
                                       "clause_ids": ["sec-2-c1", "sec-2-c2"]}]
        state["read"] = read
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        assert "品牌" not in _brief_of(chat, "报价一览表"), "struct 路的父段没被去重"
        assert "品牌" in _brief_of(chat, "报价明细表")

    def test_unclaimed_sibling_form_stays_in_the_parent(self, monkeypatch):
        """②父段只摘被认领的子块：没人认领的「3-2.配件报价表」必须留在父段——
        裁断式去重会把它从所有章里抹掉，一份招标要求的表单凭空消失（评审复现，废标级）。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "报价一览表", "items": []})
        state["outline"]["chapters"][1].update({"title": "报价明细表", "items": []})
        state["read"] = self._price_read(extra=[
            {"id": "sec-2-c8", "text": "3-2.配件报价表"},
            {"id": "sec-2-c9", "text": "序号\t配件名称\t数量\t单价（元）"},
            {"id": "sec-2-c10", "text": "注：配件报价含备件与运杂费用。"},
        ])
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        parent = _brief_of(chat, "报价一览表")
        assert "配件名称" in parent, "没人认领的兄弟表单被去重误删——招标要求的表单消失"
        assert "品牌" not in parent

    def test_no_deviation_promise_letter_keeps_its_template(self, monkeypatch):
        """③「无偏离承诺函」是真表单：裸「偏离」子串会把它误判成偏离表章、剥掉模板保护，
        潍坊式改写事故（7 条固定条款写成 6 条新措辞）对这类章复发（评审复现）。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "无偏离承诺函", "structure_ref": "s9", "items": []})
        state["read"] = {
            "required_structure": [{"id": "s9", "title": "无偏离承诺函", "kind": "form",
                                    "clause_ids": ["sec-5-c1"]}],
            "doc_sections": [{"id": "sec-5-c1",
                              "text": "无偏离承诺函\n致：招标人\n我方郑重承诺：完全响应招标文件全部条款，无任何偏离。\n供应商盖章："}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "无偏离承诺函")
        assert "招标格式模板" in brief, "无偏离承诺函被偏离子串误杀，失去模板保护"
        assert "完全响应招标文件全部条款" in brief

    def test_deviation_struct_of_any_kind_skips_the_template_path(self, monkeypatch):
        """④判定与投递同口径：structure_ref 指向「技术偏离表」构成项（kind=table，不在表单
        子集里）的章也不得进模板保真——一边收偏离条目一边被模板钉死＝197 字空壳复发（评审复现）。"""
        state = _state(2)
        state["outline"]["chapters"][0].update({"title": "技术参数响应一览表", "structure_ref": "s7", "items": []})
        state["read"] = {
            "required_structure": [{"id": "s7", "title": "技术偏离表", "kind": "table",
                                    "clause_ids": ["sec-7-c1"]}],
            "categories": [{"key": "technical", "title": "技术", "items": [
                {"title": "吞吐量", "value": "10G", "star": True, "clause_ids": ["sec-7-c1"]}]}],
            "doc_sections": [{"id": "sec-7-c1", "text": "技术参数响应一览表"},
                             {"id": "sec-7-c2", "text": "序号\t参数\t响应"}]}
        chat = _FakeChat()
        _run(state, chat, monkeypatch=monkeypatch)
        brief = _brief_of(chat, "技术参数响应一览表")
        assert "偏离表指引" in brief, "偏离章丢了条目通路"
        assert "招标格式模板" not in brief, "偏离章（kind=table 构成项）仍进了模板保真"

    def test_ascending_boundary_after_child_keeps_junk_out(self):
        """⑤编号链允许 (3,1)→(4,) 递进：拒掉的话「4.资格文件」混进明细表的段成垃圾固定
        片段，保真检对着它必杀所有如实填表的稿（评审复现）。"""
        from agent.agents.bidding_agent.nodes.form_locate import build_form_index, find_form
        read = {"doc_sections": [
            {"id": "sec-2-c1", "text": "3.报价一览表"},
            {"id": "sec-2-c2", "text": "序号\t项目名称\t数量"},
            {"id": "sec-2-c3", "text": "3-1.报价明细表"},
            {"id": "sec-2-c4", "text": "序号\t产品名称\t品牌"},
            {"id": "sec-2-c5", "text": "4.资格文件"},
            {"id": "sec-2-c6", "text": "资格文件应包括营业执照复印件。"},
        ], "doc_headings": []}
        text = find_form(build_form_index(read), "报价明细表")
        assert "资格文件" not in text, "「4.xxx」没接上链，垃圾混进了明细表模板"
