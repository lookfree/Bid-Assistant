"""审查输入的紧凑化。

审查按章截断在 _CHAPTER_CAP=4000，而**标签同样占额度**。2026-08-07 全量实测：喂进去的
2066168 字符里只有 924829 是正文，56% 花在 HTML 标签上；最糟的一章正文才 5261 字、本来
整章都放得下，却因为 <td>/<tr> 把串撑到 38431，模型只读到 561 字（10%）。

所以截断前先压实。但压实不能压掉表格结构——审查判断「★条款有没有逐条登进偏离表」靠的就是
一行一行的表格；压成一坨连续文字，这个判断就做不了了。
"""
from agent.agents.bidding_agent.nodes.common import html_to_review_text

TABLE = (
    '<table border="1"><thead><tr><th>序号</th><th>招标要求</th><th>响应</th></tr></thead>'
    "<tbody><tr><td>1</td><td>★国密SM3</td><td>完全响应</td></tr>"
    "<tr><td>2</td><td>★防拆自毁</td><td>完全响应</td></tr></tbody></table>"
)


class TestStructure:
    def test_table_rows_stay_on_their_own_lines(self):
        """一行一条要求。合并成一行，审查就分不清哪条★登了、哪条没登。"""
        lines = [ln for ln in html_to_review_text(TABLE).split("\n") if ln.strip()]
        assert len(lines) == 3
        assert "★国密SM3" in lines[1] and "★防拆自毁" in lines[2]

    def test_cells_stay_separated(self):
        """要求与响应之间要有分隔，否则「★国密SM3完全响应」读起来像一整句。"""
        assert "★国密SM3 | 完全响应" in html_to_review_text(TABLE)

    def test_paragraphs_separate(self):
        assert html_to_review_text("<p>甲</p><p>乙</p>").split("\n") == ["甲", "乙"]


class TestCompaction:
    def test_tags_are_gone(self):
        out = html_to_review_text(TABLE)
        assert "<" not in out.replace("<2", "")  # 实体解码出的 < 不算

    def test_much_smaller_than_the_raw_html(self):
        assert len(html_to_review_text(TABLE)) < len(TABLE) / 2

    def test_entities_are_decoded(self):
        """&nbsp; 一个就占 6 个字符，表格里成片出现，纯属白烧额度。"""
        out = html_to_review_text("<p>响应时间&lt;2小时&nbsp;&nbsp;&amp;并发</p>")
        assert "<2小时" in out and "&amp;" not in out and "&nbsp;" not in out


class TestImages:
    def test_image_becomes_a_short_marker_carrying_its_alt(self):
        """内联 base64 单张二十万字符。alt 里是 OCR 识别到的证照文字，审查靠它判断材料在不在。"""
        html = '<p><img src="data:image/png;base64,' + "A" * 5000 + '" alt="营业执照.png｜统一社会信用代码913100"></p>'
        out = html_to_review_text(html)
        assert len(out) < 60
        assert "营业执照.png" in out and "913100" in out

    def test_generic_alt_collapses(self):
        assert html_to_review_text('<p><img src="x" alt="插图"></p>') == "［图片］"


class TestEdges:
    def test_empty(self):
        assert html_to_review_text("") == "" and html_to_review_text(None) == ""

    def test_plain_text_survives(self):
        assert html_to_review_text("没有任何标签的正文") == "没有任何标签的正文"
