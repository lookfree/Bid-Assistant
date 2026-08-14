"""表单章模板渲染（零模型时代，2026-08-14 模型退场后）：招标模板原文 → 线上稿 HTML。
保真判定函数已随模型稿一同退役——没有模型稿，就没有"改没改原文"要判。"""

from agent.agents.bidding_agent.nodes.form_fidelity import template_html

# 潍坊那单的报价函形状：固定条款 + 留给投标人的空位 + 占位括注
TEMPLATE = """报价函
致：潍坊环境工程职业学院
1、根据已收到的项目编号____的采购项目，我方决定参加本项目的投标。
2、我方同意本报价函自开标之日起 90 天内有效。
3、我方承诺在中标后按招标文件规定的期限完成全部供货与服务。
投标人：（投标人名称）（盖章）
日期：____年__月__日"""


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


class TestTemplateLeadingBlank:
    """2026-08-14 零模型线上稿实测：授权书首个空位在**行首**（缩进+长空格串），
    template_html 全 strip 会把它吃掉——填空引擎无处落笔，供应商全称槽线上永远留白。"""

    def test_leading_space_blank_survives_and_fills(self):
        from agent.agents.bidding_agent.nodes.form_fidelity import template_html
        from agent.agents.bidding_agent.render.form_copier import fill_blanks_html
        raw = ("法定代表人授权书\n"
               "                 （供应商全称）法定代表人           授权"
               "         （全权代表姓名）为全权代表，参加询比活动。")
        html = template_html(raw, "法定代表人授权书")
        out, n = fill_blanks_html(html, [("单位名称", "上海安几科技有限公司"),
                                         ("法定代表人", "于新宇"),
                                         ("全权代表姓名", "胡月")], {})
        assert n == 3, f"行首空位没存活,只填了 {n} 处"
        assert "上海安几科技有限公司" in out and "于新宇" in out and "胡月" in out
