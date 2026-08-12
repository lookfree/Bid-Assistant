"""表单章保真判定：模型只许填空，改了原文必须被代码逮住。"""

from agent.agents.bidding_agent.nodes.form_fidelity import (
    fixed_segments, keeps_template, template_html)

# 潍坊那单的报价函形状：固定条款 + 留给投标人的空位 + 占位括注
TEMPLATE = """报价函
致：潍坊环境工程职业学院
1、根据已收到的项目编号____的采购项目，我方决定参加本项目的投标。
2、我方同意本报价函自开标之日起 90 天内有效。
3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。
投标人：（投标人名称）（盖章）
日期：____年__月__日"""


class TestKeepsTemplate:
    def test_filling_the_blanks_passes(self):
        """填空是允许的——这正是我们要模型做的事。"""
        html = ("<p>报价函</p><p>致：潍坊环境工程职业学院</p>"
                "<p>1、根据已收到的项目编号 WFHJ-2026-011 的采购项目，我方决定参加本项目的投标。</p>"
                "<p>2、我方同意本报价函自开标之日起 90 天内有效。</p>"
                "<p>3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</p>"
                "<p>投标人：上海安几科技有限公司（盖章）</p><p>日期：2026年8月12日</p>")
        assert keeps_template(html, TEMPLATE)

    def test_rewriting_a_fixed_clause_is_caught(self):
        """招标写「自开标之日起 90 天内有效」，模型写成「有效期为九十日」——
        这就是用户截图里的原病（7 条固定条款被改成 6 条全新措辞）。"""
        html = ("<p>报价函</p><p>致：潍坊环境工程职业学院</p>"
                "<p>1、根据已收到的项目编号 WFHJ-2026-011 的采购项目，我方决定参加本项目的投标。</p>"
                "<p>2、本报价函有效期为九十日。</p>"
                "<p>3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</p>")
        assert not keeps_template(html, TEMPLATE)

    def test_dropping_a_clause_is_caught(self):
        """少写一条也是不一致——用户实测就是 7 条变 6 条。"""
        html = ("<p>报价函</p><p>致：潍坊环境工程职业学院</p>"
                "<p>1、根据已收到的项目编号 X 的采购项目，我方决定参加本项目的投标。</p>"
                "<p>3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</p>")
        assert not keeps_template(html, TEMPLATE)

    def test_reordering_clauses_is_caught(self):
        """顺序也是格式的一部分：条款重排同样是「与招标格式不一致」。"""
        html = ("<p>报价函</p><p>致：潍坊环境工程职业学院</p>"
                "<p>3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</p>"
                "<p>2、我方同意本报价函自开标之日起 90 天内有效。</p>"
                "<p>1、根据已收到的项目编号 X 的采购项目，我方决定参加本项目的投标。</p>")
        assert not keeps_template(html, TEMPLATE)

    def test_reflowing_into_a_table_is_not_a_rewrite(self):
        """换标签、换排版不算改写——比的是字，不是 HTML。"""
        html = ("<table><tr><td>报价函</td></tr>"
                "<tr><td>致：潍坊环境工程职业学院</td></tr>"
                "<tr><td>1、根据已收到的项目编号 X\n的采购项目，我方决定参加本项目的投标。</td></tr>"
                "<tr><td>2、我方同意本报价函自开标之日起 90 天内有效。</td></tr>"
                "<tr><td>3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</td></tr></table>")
        assert keeps_template(html, TEMPLATE)

    def test_html_entities_do_not_count_as_a_rewrite(self):
        """转义实体是渲染细节：&amp; 与 & 是同一个字。"""
        tpl = "我方承诺遵守《招标文件》第 3 条 A&B 类设备的全部要求，不作任何保留。"
        assert keeps_template("<p>我方承诺遵守《招标文件》第 3 条 A&amp;B 类设备的全部要求，不作任何保留。</p>", tpl)

    def test_inserting_a_heading_between_lines_is_tolerated(self):
        """表单章本来就需要一个标题。判据若严到连这个都不许，保真机制会天天误伤，
        每一章都退回空表——那比不做还糟。插入放过，改写不放过。"""
        html = ("<h3>第一章 报价函</h3><p>报价函</p><p>致：潍坊环境工程职业学院</p>"
                "<p>（以下为我方响应）</p>"
                "<p>1、根据已收到的项目编号 X 的采购项目，我方决定参加本项目的投标。</p>"
                "<p>2、我方同意本报价函自开标之日起 90 天内有效。</p>"
                "<p>3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。</p>")
        assert keeps_template(html, TEMPLATE)

    def test_a_template_that_is_all_blanks_never_fails(self):
        """整份都是空位时没有可判定的东西，不该冤杀产出。"""
        assert keeps_template("<p>随便写的</p>", "____\n________\n____")


class TestFixedSegments:
    def test_blanks_and_placeholders_are_not_fixed_text(self):
        segs = fixed_segments(TEMPLATE)
        assert not any("（投标人名称）" in s for s in segs), "占位括注被当成固定文字 → 正常替换会被判死"
        assert not any("_" in s for s in segs)

    def test_short_fragments_are_ignored(self):
        """「致：」「1、」这类碎片到处都是，拿它们比对只会误判。"""
        assert all(len(s) >= 6 for s in fixed_segments(TEMPLATE))


class TestTemplateHtml:
    def test_tab_separated_lines_become_table_rows(self):
        """报价一览表在解析文本里是制表符分列的行，摊成段落就不成表了。"""
        out = template_html("开标一览表\n序号\t名称\t报价\n1\t零信任网关\t____")
        assert "<table>" in out and out.count("<tr>") == 2   # 标题行没有制表符，是段落不是表行
        assert "<td>零信任网关</td>" in out

    def test_plain_lines_become_paragraphs_and_are_escaped(self):
        out = template_html("致：招标人 <不转义就破页>", title="报价函")
        assert "<h3>报价函</h3>" in out
        assert "&lt;不转义就破页&gt;" in out

    def test_the_fallback_render_passes_its_own_check(self):
        """退路必须自洽：拿模板渲染出来的东西，再去判一次必须通过。"""
        assert keeps_template(template_html(TEMPLATE), TEMPLATE)
