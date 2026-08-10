"""PDF 章节切分（2026-08-11 生产实测缺陷）。

取证：一份 366 页 / 12.9 万字 / 4947 条条款的商务技术标只切出 **4 节 / 5 个标题**，其中两条
还是承诺函正文被编号骗进来的（「五、保证不将上述任何相关内容泄露给第三方」「六、以上如有违反…」）；
另一份 8 页的经济标切出 1 节。模型拿到的是整本无结构大坨文本，在里面找不到具体条款。

旧判据只认「第N章」和「一、」两种写法，且对 PDF 抽出来的**物理行**（一行 40 字上下，正文行
条条过得了长度门槛）毫无抵抗力。这一组用例锁住新的判据顺序：书签树 → 排版字号/字重 →
收紧后的编号启发式，以及三条不许回归的红线（页眉页脚不成标题、金额日期不成标题、
碎节合并不许级联坍塌）。

语种相关的判据直接喂 PdfLine（fpdf2 的内置字体不支持中文，造不出带中文的测试 PDF，而判据
本身与「怎么从 PDF 里把行取出来」无关）；书签与字号这两条**链路**则用真 PDF 走完整解析。
"""
from agent.parsing.parsers import parse_bytes, splice_ocr_pages
from agent.parsing.pdf_sections import PdfLine, split_pdf_lines
from agent.parsing.types import SYSTEM_NOTE_PREFIX

_BODY = 10.5


def _doc(pages: list[list[tuple]]) -> list[PdfLine]:
    """[[(文字, 字号[, 加粗]), …], …] → PdfLine 列表（页号/行号自动编）。"""
    out: list[PdfLine] = []
    for p, rows in enumerate(pages):
        for i, row in enumerate(rows):
            out.append(PdfLine(text=row[0], page=p, index=i, size=row[1],
                               bold=row[2] if len(row) > 2 else False))
    return out


def _titles(headings: list[dict]) -> list[str]:
    return [h["title"] for h in headings]


def _sec_count(clauses: list[dict], headings: list[dict]) -> int:
    nums = [int(x["id"].rsplit("-c", 1)[0].removeprefix("sec-")) for x in clauses]
    nums += [int(h["sec"].removeprefix("sec-")) for h in headings]
    return max(nums) if nums else 0


def _sec_of(clauses: list[dict], needle: str) -> str:
    for c in clauses:
        if needle in c["text"]:
            return c["id"].rsplit("-c", 1)[0]
    raise AssertionError(f"条款里找不到 {needle}")


def _body(n: int, tag: str) -> list[tuple]:
    return [(f"{tag}第{i}段正文，本项目采用综合评估法确定中标候选人", _BODY) for i in range(n)]


class TestPdfOwnStructure:
    """PDF 自己带的结构信息（书签树、排版字号）优先于任何正则猜测。"""

    def test_bookmarks_become_sections(self):
        """带书签树的标书 PDF：书签就是作者标好的章节结构，直接成节。
        正文与标题**同一字号**——这里单独锁书签这条信号，不让字号信号插手。"""
        from fpdf import FPDF
        from fpdf.outline import TextStyle

        pdf = FPDF()
        pdf.set_section_title_styles(TextStyle(font_size_pt=10.5), TextStyle(font_size_pt=10.5))
        pdf.set_font("helvetica", size=10.5)
        pdf.add_page()
        for n, (title, level) in enumerate(
                [("Chapter One Invitation", 0), ("1.1 Qualification", 1),
                 ("Chapter Two Requirements", 0), ("2.1 Delivery", 1)]):
            pdf.start_section(title, level=level)
            for i in range(3):
                pdf.multi_cell(0, 6, new_x="LMARGIN", new_y="NEXT",
                               text=f"Body line {n}-{i} of a bid document section")

        parsed = parse_bytes(bytes(pdf.output()), "t.pdf")
        assert _titles(parsed.headings) == ["Chapter One Invitation", "1.1 Qualification",
                                            "Chapter Two Requirements", "2.1 Delivery"]
        assert [h["level"] for h in parsed.headings] == [1, 2, 1, 2]
        # 标题另存 headings、不进 clauses（口径与 docx/xlsx 一致）
        assert not any("Chapter One Invitation" in c["text"] for c in parsed.clauses)
        assert _sec_of(parsed.clauses, "Body line 2-0") == "sec-3"

    def test_font_size_hierarchy_becomes_sections(self):
        """没有书签、但版面用字号分了层：大字行就是标题，正文行一条都不许成标题。"""
        from fpdf import FPDF

        pdf = FPDF()
        pdf.add_page()
        for n, (title, size) in enumerate([("Section One Scope", 18), ("Item A Details", 14),
                                           ("Section Two Terms", 18), ("Item B Details", 14)]):
            pdf.set_font("helvetica", size=size)
            pdf.multi_cell(0, 10, new_x="LMARGIN", new_y="NEXT", text=title)
            pdf.set_font("helvetica", size=10.5)
            for i in range(4):
                pdf.multi_cell(0, 6, new_x="LMARGIN", new_y="NEXT",
                               text=f"Body line {n}-{i} of this bid document paragraph")

        parsed = parse_bytes(bytes(pdf.output()), "t.pdf")
        assert _titles(parsed.headings) == ["Section One Scope", "Item A Details",
                                            "Section Two Terms", "Item B Details"]
        # 18pt 是一级、14pt 是二级：层级按字号从大到小排名
        assert [h["level"] for h in parsed.headings] == [1, 2, 1, 2]
        assert _sec_count(parsed.clauses, parsed.headings) == 4

    def test_headings_resolve_clause_ids_back_to_a_readable_source(self):
        """headings 要能把内部条款 id 还原成人看得懂的出处（偏离表「出处」列、前端锚点）。"""
        lines = _doc([[("第一章 投标邀请", 16.0), *_body(6, "邀请"),
                       ("第二章 投标人须知", 16.0), *_body(6, "须知"),
                       ("第三章 评标办法", 16.0), *_body(6, "评标")]])
        clauses, headings, _ = split_pdf_lines(lines)
        sec = _sec_of(clauses, "须知第0段")
        assert [h["title"] for h in headings if h["sec"] == sec] == ["第二章 投标人须知"]


class TestFalseTitles:
    """被编号骗进来的假标题——每一条都是实测到的形态。"""

    def test_promise_letter_items_are_not_titles(self):
        """承诺函正文（「五、保证不将…」「六、以上如有违反…」）与真章节字面上一模一样，
        分开它们的**唯一**信号是字号：真标题在版面上显著更大，承诺函每一条都是正文字号。"""
        lines = _doc([[
            ("第一章 投标邀请", 16.0), *_body(6, "邀请"),
            ("第二章 投标人须知", 16.0), *_body(6, "须知"),
            ("保密承诺函", 16.0),
            ("一、我方承诺对招标文件的全部内容严格保密", _BODY),
            ("二、未经招标人书面同意不得复制留存", _BODY),
            ("五、保证不将上述任何相关内容泄露给第三方", _BODY),
            ("六、以上如有违反愿承担由此引起的一切责任", _BODY),
        ]])
        clauses, headings, _ = split_pdf_lines(lines)
        assert _titles(headings) == ["第一章 投标邀请", "第二章 投标人须知", "保密承诺函"]
        # 承诺函那几条必须还留在条款里：判成标题就等于把这几句承诺从审查材料里删掉
        assert any("五、保证不将上述任何相关内容泄露给第三方" == c["text"] for c in clauses)

    def test_repeated_header_and_footer_lines_are_not_titles(self):
        """每页重复的页眉/页脚（项目名、公司名）在正文里出现几百次。旧判据把它当标题，
        一份 300 页的标书就凭空多出 300 个同名假节。"""
        header = ("一、二级等保安全服务采购项目投标文件", _BODY)
        pages = [[header, *_body(4, f"第{p}页")] for p in range(10)]
        pages[0].insert(1, ("第一章 投标邀请", _BODY))
        pages[5].insert(1, ("第二章 投标人须知", _BODY))
        clauses, headings, _ = split_pdf_lines(_doc(pages))
        assert _titles(headings) == ["第一章 投标邀请", "第二章 投标人须知"]
        assert all("采购项目投标文件" not in t for t in _titles(headings))
        assert any("采购项目投标文件" in c["text"] for c in clauses)   # 文字一个字都没丢

    def test_amounts_and_dates_are_not_titles(self):
        """封面上的金额与日期常常排得比正文大得多（这里 22pt，比章标题还大），但它们不是章节
        （docx 那边刚踩过：幻影节还会顺移其后所有 clause id）。"""
        lines = _doc([[
            ("￥1,234,567.00元", 22.0), ("2026年8月1日", 22.0), ("二〇二六年八月", 22.0),
            # 「零」在落款里有三种打法，少认一种就凭空多切一节：实测「广州市建设工程施工公开招标
            # 招标文件范本.pdf」的封面写的是 U+25CB 的「二○二二年三月」，Ｏ 是全角字母那一种。
            ("二○二二年三月", 22.0), ("二Ｏ二二年三月", 22.0),
            ("第一章 采购需求", 16.0), *_body(12, "需求"),
            ("第二章 商务要求", 16.0), *_body(12, "商务"),
            ("第三章 合同条款", 16.0), *_body(12, "合同"),
        ]])
        _, headings, _ = split_pdf_lines(lines)
        assert _titles(headings) == ["第一章 采购需求", "第二章 商务要求", "第三章 合同条款"]

    def test_table_of_contents_lines_are_not_titles(self):
        """目录行与真标题字面一模一样，只多一串牵引到页码——放行就是开头一批假节，
        而且它们排在正文之前，把真正的第一章挤到 sec-4 去。目录页与正文**同一字号**，
        所以这一关只能靠目录行自己的形状（点线牵引 / 空格拉开的尾页码）拦。"""
        lines = _doc([[
            ("第一章 投标邀请..................1", _BODY),
            ("第二章 投标人须知................5", _BODY),
            ("第三章 评标办法    9", _BODY),
            ("第一章 投标邀请", _BODY), *_body(5, "邀请"),
            ("第二章 投标人须知", _BODY), *_body(5, "须知"),
            ("第三章 评标办法", _BODY), *_body(5, "评标"),
        ]])
        _, headings, _ = split_pdf_lines(lines)
        assert _titles(headings) == ["第一章 投标邀请", "第二章 投标人须知", "第三章 评标办法"]


class TestFallback:
    """字号与书签都没有时的退路，以及退路本身不许把文档切碎或压塌。"""

    def test_uniform_font_falls_back_to_numbering(self):
        """通篇一个字号、没有书签：只剩编号可猜，多级编号要能切出层级。"""
        lines = _doc([[
            ("1 技术偏离表", _BODY), *_body(3, "偏离"),
            ("1.1 总体技术规范偏离表", _BODY), *_body(3, "总体"),
            ("1.1.2 核心架构要求偏离表", _BODY), *_body(3, "架构"),
            ("2 项目概况", _BODY), *_body(3, "概况"),
        ]])
        _, headings, _ = split_pdf_lines(lines)
        assert _titles(headings) == ["1 技术偏离表", "1.1 总体技术规范偏离表",
                                     "1.1.2 核心架构要求偏离表", "2 项目概况"]
        assert [h["level"] for h in headings] == [1, 2, 3, 1]

    def test_one_long_table_does_not_drag_numbering_noise_into_the_whole_document(self):
        """2026-08-11 真文件实测（366 页那份）：字号信号已经认出 173 条标题、平均 29 行一条，
        只因末尾一张长表没有大字标题，就把编号启发式并进全文——灌进来 129 条评分表行与
        索引表行（「1.  应答方名称 P16-P18 /」「2.具备PMP证书…满足得1」）。
        **密度够就不补**：为了一段长表把整本弄脏不划算。"""
        rows: list[tuple] = []
        for c in range(20):
            rows.append((f"第{c + 1}章 技术要求", 16.0))
            rows += [(f"{i + 1}、评分项{i + 1}：满足得1分，不满足不得分", _BODY) for i in range(15)]
        rows += [(f"{i + 1}.  评审索引项{i + 1} P{i + 1} /", _BODY) for i in range(250)]
        _, headings, _ = split_pdf_lines(_doc([rows]))
        assert _titles(headings) == [f"第{c + 1}章 技术要求" for c in range(20)]

    def test_a_document_marked_too_coarsely_still_falls_back_to_numbering(self):
        """反过来：只有三行大字、铺得再匀，几百行正文里也一条标题都没有——
        「最长空档不过全文一半」这道线是过得了的，**密度**过不了，必须补编号。
        366 页只切出 4 节正是这个形态。"""
        rows: list[tuple] = [(f"{i + 1}、服务条目{i + 1}的详细要求与响应说明", _BODY)
                             for i in range(700)]
        for at, title in ((700, "商务标书"), (350, "技术标书"), (0, "投标文件")):
            rows.insert(at, (title, 22.0))
        clauses, headings, _ = split_pdf_lines(_doc([rows]))
        assert _sec_count(clauses, headings) > 20, "切得太粗时没有补编号"

    def test_document_without_any_structure_stays_one_section(self):
        """一个可识别结构都没有的 PDF **退回今天的行为**：整份一节，不凭空造标题。"""
        lines = _doc([[(f"本项目服务期三年，第{i}项服务内容详见技术规范书附件", _BODY)
                       for i in range(30)]])
        clauses, headings, marks = split_pdf_lines(lines)
        assert headings == [] and marks == []
        assert len(clauses) == 30 and all(c["id"].startswith("sec-1-c") for c in clauses)

    def test_merging_tiny_sections_never_cascades_into_one(self):
        """编号列表项被当成标题时会切出上千个碎节，必须并；但**并到够大就收手**——
        docx 那边踩过级联坍塌（400 条列表项一路并成 1 节）。这里锁死节数下界。"""
        rows: list[tuple] = []
        for i in range(300):
            rows.append((f"{i + 1}、服务要求条目{i + 1}", _BODY))
            rows.append((f"投标人须按本条要求提供相应服务与响应说明第{i}条", _BODY))
        clauses, headings, _ = split_pdf_lines(_doc([rows]))
        n = _sec_count(clauses, headings)
        assert 20 <= n <= 300, f"碎节合并把 300 个编号条目压成了 {n} 节"
        assert len(clauses) + len(headings) == 600      # 一行文字都没丢


class TestOcrSplice:
    """扫描页识别文字拼回正文之后，章节结构必须原样保住。"""

    def test_ocr_text_neither_becomes_a_title_nor_moves_the_sections(self):
        """识别出来的行大量长成「1. Legal representative: …」，正是启发式眼里的标题。
        拼回后**沿用解析时定下的标题坐标**：新标题一个都不许冒出来，老标题一个都不许丢。"""
        from fpdf import FPDF

        pdf = FPDF()
        pdf.add_page()
        for n, title in enumerate(["Section One Scope", "Section Two Terms", "Section Three Fee"]):
            pdf.set_font("helvetica", size=18)
            pdf.multi_cell(0, 10, new_x="LMARGIN", new_y="NEXT", text=title)
            pdf.set_font("helvetica", size=10.5)
            for i in range(4):
                pdf.multi_cell(0, 6, new_x="LMARGIN", new_y="NEXT",
                               text=f"Body line {n}-{i} of this bid document paragraph")
        pdf.add_page()                        # 无文字 = 扫描图片页
        parsed = parse_bytes(bytes(pdf.output()), "t.pdf")
        assert parsed.image_pages == 1 and len(parsed.heading_marks) == 3

        ocr = "1. Legal representative: Zhang San\n2. Certificate number: 91310000MA1K3XXXX"
        after = splice_ocr_pages(parsed, {1: ocr})
        assert _titles(after.headings) == _titles(parsed.headings)
        assert _sec_count(after.clauses, after.headings) == _sec_count(parsed.clauses,
                                                                      parsed.headings)
        assert any("Zhang San" in c["text"] for c in after.clauses)

    def test_a_note_replacing_a_titled_scan_page_never_inherits_that_title(self):
        """整页被替换掉的扫描页上原本有一条标题坐标：坐标之外**还要核对行文字**。

        可达条件不苛刻——一页只印一行短标题 + 一张证照图，就同时满足「有标题坐标」
        （字号比正文大）和「是扫描图片页」（可见文字不足 20 字）。识别文字拼回时整页被替换，
        原标题所在的那一行变成了页首注记；只认坐标的话，「【系统注记·扫描页识别 第N页】」
        会被当成章节标题——把我们自己的注记印成用户标书的一节。

        反向变异：把 resplit_marked 里的 `m.get("text") == _norm(t)` 复核去掉，本用例变红。
        """
        from fpdf import FPDF

        pdf = FPDF()
        pdf.add_page()
        for n, title in enumerate(["Section One Scope", "Section Two Terms"]):
            pdf.set_font("helvetica", size=18)
            pdf.multi_cell(0, 10, new_x="LMARGIN", new_y="NEXT", text=title)
            pdf.set_font("helvetica", size=10.5)
            for i in range(6):
                pdf.multi_cell(0, 6, new_x="LMARGIN", new_y="NEXT",
                               text=f"Body line {n}-{i} of this bid document paragraph")
        pdf.add_page()                       # 只印一行短标题的页 = 有标题坐标，且算扫描图片页
        pdf.set_font("helvetica", size=18)
        pdf.multi_cell(0, 10, new_x="LMARGIN", new_y="NEXT", text="Fee Terms")
        parsed = parse_bytes(bytes(pdf.output()), "t.pdf")
        assert parsed.image_pages == 1                                   # 第二页确实算扫描页
        assert any(m["page"] == 1 for m in parsed.heading_marks)         # 且它上面有标题坐标

        after = splice_ocr_pages(parsed, {1: "1. Legal representative: Zhang San of the bidder"})
        assert all(SYSTEM_NOTE_PREFIX not in t for t in _titles(after.headings)), _titles(after.headings)
        assert any("Zhang San" in c["text"] for c in after.clauses)      # 识别文字照常进条款
