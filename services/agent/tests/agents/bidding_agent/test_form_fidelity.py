"""表单章保真判定：模型只许填空，改了原文必须被代码逮住。"""

from agent.agents.bidding_agent.nodes.form_fidelity import (
    first_missing_segment, fixed_segments, keeps_template, template_html)

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

    # 2026-08-13 云上江西第二轮实测原样（报价一览表）：表行间的「1」「2」是空行号行，
    # 「合计（大写）：」重复文本是解析层摊平的合并单元格。
    _PRICE_TPL = ("序号\t项目名称\t数量\t单价（元）\t总价（元）\t税率\n"
                  "1\n2\n"
                  "合计（大写）：\t合计（大写）：\n"
                  "3-1.报价明细表")

    def test_bare_row_numbers_stay_inside_the_table(self):
        """空行号行归回表里：渲染成表外的孤立段落，表格被切成两张、中间夹着「1」「2」
        两个光秃段——用户口径就是「格式和招标文件不一样」（2026-08-13 实测）。"""
        out = template_html(self._PRICE_TPL, title="报价一览表")
        assert out.count("<table>") == 1, "一张表被切碎了"
        assert "<p>1</p>" not in out and "<p>2</p>" not in out
        assert out.count("<tr>") == 4          # 表头 + 两个空行号行 + 合计行
        assert "<td>1</td><td></td>" in out    # 行号行右侧补空格，列数对齐

    def test_repeated_cells_become_one_merged_cell(self):
        """「合计（大写）：」×N 还原成一格 colspan——重复文本本就是合并单元格摊平的产物。
        还原后必须仍过保真自洽（fixed_segments 折叠行内重复格与此配套）。"""
        out = template_html(self._PRICE_TPL, title="报价一览表")
        assert '<td colspan="6">合计（大写）：</td>' in out
        assert out.count("合计（大写）：") == 1
        assert keeps_template(out, self._PRICE_TPL), "合并渲染过不了保真检=正确还原被判死"

    def test_sign_lines_align_right_but_date_and_name_stay_left(self):
        """落款（签字/签章/盖章）按表单惯例靠右；「供应商名称：」「日期：」在响应函里
        属左侧落款块，不得跟着靠右。"""
        tpl = "法定代表人签字或签章：\n供应商签章：\n供应商名称：\n日期： 年  月  日"
        out = template_html(tpl)
        assert '<p style="text-align:right">法定代表人签字或签章：</p>' in out
        assert '<p style="text-align:right">供应商签章：</p>' in out
        assert "<p>供应商名称：</p>" in out
        assert "<p>日期： 年  月  日</p>" in out

    def test_title_param_skipped_when_first_line_is_the_same_title(self):
        """首行就是表单抬头时不再另出章名 h3——否则一左一中两个同名标题叠着
        （2026-08-13 授权书实测）。首行不是抬头时章名照出。"""
        out = template_html("法定代表人授权书\n致：云上（江西）安全技术有限公司", title="法定代表人授权书")
        assert out.count("<h3") == 1
        assert '<h3 style="text-align:center">法定代表人授权书</h3>' in out
        out2 = template_html("致：招标人 <不转义就破页>", title="报价函")
        assert "<h3>报价函</h3>" in out2

    # ---- 2026-08-13 第二轮评审 CONFIRMED 项（版式细则） ----

    def test_adjacent_blank_cells_stay_separate(self):
        """相邻同文的**空位格**（____\\t____）不并 colspan——那是每列各一个的填空格，
        并成一格横贯两列恰是「与招标版式不符」（评审复现）。"""
        out = template_html("单价（元）\t总价（元）\n____\t____")
        assert '<td>____</td><td>____</td>' in out
        assert 'colspan' not in out

    def test_blank_line_between_table_rows_does_not_split_the_table(self):
        """表行间夹空行不冲表——冲掉后面的裸行号又碎回 <p>1</p> 孤立段落（评审复现）。"""
        out = template_html("序号\t名称\t数量\n\n1\n2\n合计（大写）：\t合计（大写）：")
        assert out.count("<table>") == 1
        assert "<p>1</p>" not in out

    def test_numbered_signature_clause_stays_left(self):
        """「3、本响应函须由法定代表人签字：」是表单正文条款，原文靠左——
        含签字字样就甩到右边距是误伤（评审复现）。"""
        out = template_html("3、本响应函须由法定代表人签字：\n法定代表人签字或签章：")
        assert "<p>3、本响应函须由法定代表人签字：</p>" in out
        assert '<p style="text-align:right">法定代表人签字或签章：</p>' in out

    def test_unrenderable_dup_title_keeps_the_chapter_heading(self):
        """首行与章名同名但**渲染不成抬头**（带括注，is_form_title_line 拒收）→ 章名 h3
        必须保留，否则整章一个标题都没有（评审复现）。"""
        out = template_html("报价一览表（格式）\n序号\t名称", title="报价一览表（格式）")
        assert "<h3>报价一览表（格式）</h3>" in out

    def test_form_title_line_renders_centered(self):
        """表单抬头（「响   应   函」）要排成**居中标题**——招标表单的抬头都是居中的，
        排成左对齐正文段落就是「格式跟招标书不一样」（2026-08-13 用户实测反馈）。
        抬头里的排版空格照抄不动（逐字保真），居中靠 style，不靠改字。"""
        tpl = "响   应   函\n致：【XX公司[采购人名称]】：\n我方承诺如下内容：全部照办。"
        out = template_html(tpl, title="响应函")
        assert '<h3 style="text-align:center">响   应   函</h3>' in out
        assert "<p>致：【XX公司[采购人名称]】：</p>" in out, "正文行不该被当抬头"
        assert keeps_template(out, tpl), "居中抬头不得破坏保真自洽"


class TestFalseRejects20260814:
    """2026-08-14 云上江西生产拒稿五案里的三类冤杀（agent_event_log 真实样本），
    修法=比对豁免收准，交付内容一个字不动。"""

    def test_fullwidth_punctuation_fill_is_not_a_rewrite(self):
        """t3 案：模板句里是半角逗号「为全权代表,参加」，模型按中文习惯写全角「，」——
        标点全半角不是改写，判死它等于要求模型逐字节复读 OCR 噪声。"""
        tpl = "（供应商全称）法定代表人 授权 （全权代表姓名）为全权代表,参加贵处组织的项目询比活动。"
        draft = "<p>上海安几科技有限公司法定代表人 授权 胡月为全权代表，参加贵处组织的项目询比活动。</p>"
        assert keeps_template(draft, tpl)

    def test_lenticular_bracket_placeholder_may_be_replaced(self):
        """t2 案：模板占位「【XX公司[采购人名称]】」被模型正确替换成真实采购人名——
        【】括注与（）括注同是占位，不豁免它，填对了反被判死。"""
        tpl = "致：【XX公司[采购人名称]】：\n我方已仔细研究了询比文件的全部内容，将严格按要求提交响应文件。"
        draft = ("<p>致：云上（江西）安全技术有限公司：</p>"
                 "<p>我方已仔细研究了询比文件的全部内容，将严格按要求提交响应文件。</p>")
        assert keeps_template(draft, tpl)

    def test_filling_an_empty_cell_between_fixed_headers_is_allowed(self):
        """b5 案：表头行「联系方式\\t联系人\\t\\t联系电话\\t」的空格子是填空位——
        折叠固定段时把空格子也粘进去，模型一填值段就断，整章冤死。"""
        tpl = "联系方式\t联系人\t\t联系电话\t\n企业性质与注册资金情况说明"
        draft = ("<table><tr><td>联系方式</td><td>联系人</td><td>王敏</td>"
                 "<td>联系电话</td><td>021-52808586</td></tr></table>"
                 "<p>企业性质与注册资金情况说明</p>")
        assert keeps_template(draft, tpl)

    def test_rewritten_fixed_text_is_still_rejected(self):
        """豁免收准不等于放水：固定文字被改写（「承诺函」→「承诺书」）照旧拒。"""
        tpl = "供应商资格信用承诺函\n我单位自愿参加本次采购询价活动并郑重承诺守信。"
        draft = "<h3>供应商资格信用承诺书</h3><p>我单位自愿参加本次采购询价活动并郑重承诺守信。</p>"
        assert first_missing_segment(draft, tpl) == "供应商资格信用承诺函"


class TestFalseRejects0814Round2:
    """2026-08-14 下午生产二轮冤杀（agent_event_log 真实 missing_segment）。"""

    def test_ordered_list_numbers_are_exempt(self):
        """b5 案：承诺函六项资格条件被模型写成 <ol><li>——编号由渲染器生成，纯文本层
        没有「1.」，整章冤死在「1.具有独立承担民事责任的能力;」。去编号再找一次。"""
        tpl = ("我单位郑重承诺符合下列资格条件：\n1.具有独立承担民事责任的能力；\n"
               "2.具有良好的商业信誉和健全的财务会计制度；")
        draft = ("<p>我单位郑重承诺符合下列资格条件：</p><ol>"
                 "<li>具有独立承担民事责任的能力；</li>"
                 "<li>具有良好的商业信誉和健全的财务会计制度；</li></ol>")
        assert keeps_template(draft, tpl)

    def test_vertical_merge_row_head_is_exempt(self):
        """b7 案：竖向合并格摊平成两行同头「联系方式|联系人…」「联系方式|传真…」，
        模型 rowspan 正确还原后第二行没有「联系方式」——重复行头当空格子断段。"""
        tpl = ("联系方式\t联系人\t\t联系电话\t\n联系方式\t传  真\t\t网址/邮箱\t\n"
               "企业性质与注册资金情况说明如下")
        draft = ("<table><tr><td rowspan=\"2\">联系方式</td><td>联系人</td><td>王敏</td>"
                 "<td>联系电话</td><td>021-52808586</td></tr>"
                 "<tr><td>传  真</td><td></td><td>网址/邮箱</td><td>a@b.cn</td></tr></table>"
                 "<p>企业性质与注册资金情况说明如下</p>")
        assert keeps_template(draft, tpl)

    def test_rewriting_the_row_head_is_still_caught(self):
        """豁免收准不放水：行头「联系方式」被改成「联络方式」照旧拒。"""
        tpl = "联系方式\t联系人\t\t联系电话\t\n供应商签章处如下所示"
        draft = ("<table><tr><td>联络方式</td><td>联系人</td><td></td><td>联系电话</td></tr></table>"
                 "<p>供应商签章处如下所示</p>")
        assert first_missing_segment(draft, tpl) is not None
