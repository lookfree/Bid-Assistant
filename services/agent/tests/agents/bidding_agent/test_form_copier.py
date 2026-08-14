"""表单章复印机 T3（spec 2026-08-14）：招标 docx 的表单节点区间深拷贝进导出文档。
版式（表格合并格/下划线/居中）靠**复制**保真，不是重建——这正是整条复印机路线的意义。"""
import io

import pytest

from agent.agents.bidding_agent.nodes.form_locate import FormSpan


def _tender_docx() -> bytes:
    """真实形态的招标表单页：居中抬头 + 致行 + 带合并格的表格 + 下划线空位落款。"""
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    d = Document()
    d.add_paragraph("前置说明段。")                                # body#0
    head = d.add_paragraph("供应商资格信用承诺函")                  # body#1 居中抬头
    head.alignment = WD_ALIGN_PARAGRAPH.CENTER
    d.add_paragraph("致（采购人）：云上（江西）安全技术有限公司")     # body#2
    t = d.add_table(rows=2, cols=3)                               # body#3
    t.cell(0, 0).merge(t.cell(0, 1))                              # 合并格
    t.cell(0, 0).text = "合计（大写）"
    t.cell(0, 2).text = "税率"
    t.cell(1, 0).text = "1"
    p = d.add_paragraph()                                          # body#4 下划线空位
    p.add_run("单位名称：")
    blank = p.add_run("____________")
    blank.underline = True
    d.add_paragraph("后续无关段。")                                # body#5
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


class TestExtract:
    def test_span_nodes_are_copied_with_layout_intact(self):
        """区间抽取的节点保留合并格/居中/下划线——逐属性断言，防「文字在版式丢」。"""
        from agent.agents.bidding_agent.render.form_copier import extract_form_nodes

        nodes = extract_form_nodes(_tender_docx(), FormSpan(1, 4, -1))
        assert len(nodes) == 4
        xml = "".join(__import__("lxml").etree.tostring(n, encoding="unicode") for n in nodes)
        assert "供应商资格信用承诺函" in xml and "云上（江西）安全技术有限公司" in xml
        assert 'w:val="center"' in xml                     # 抬头居中
        assert "gridSpan" in xml or "hMerge" in xml or "vMerge" in xml or "restart" in xml \
            or "w:merge" in xml or "continue" in xml       # 合并格痕迹（python-docx 用 gridSpan/vMerge）
        assert "<w:u " in xml or 'w:u w:val' in xml.replace("'", '"')   # 下划线空位
        assert "后续无关段" not in xml and "前置说明段" not in xml

    def test_out_of_range_span_is_rejected(self):
        from agent.agents.bidding_agent.render.form_copier import (
            CopierUnsupported, extract_form_nodes)
        with pytest.raises(CopierUnsupported):
            extract_form_nodes(_tender_docx(), FormSpan(90, 99, -1))

    def test_numbered_list_in_span_falls_back(self):
        """区间里有编号列表（numPr 引用 numbering.xml）→ 拒收：光搬节点是悬空引用，
        Word 里编号会错乱。宁可回退 HTML 路线。"""
        from docx import Document
        from agent.agents.bidding_agent.render.form_copier import (
            CopierUnsupported, extract_form_nodes)

        from docx.oxml import parse_xml

        d = Document()
        d.add_paragraph("表单头")
        p = d.add_paragraph("第一条")          # 真实 Word 编号列表在 pPr 里直挂 numPr
        p._p.get_or_add_pPr().append(parse_xml(
            '<w:numPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'))
        buf = io.BytesIO()
        d.save(buf)
        with pytest.raises(CopierUnsupported):
            extract_form_nodes(buf.getvalue(), FormSpan(0, 1, -1))

    def test_image_in_span_falls_back(self):
        """区间里有图片引用（blip 指媒体部件）→ 拒收，同理悬空。"""
        from docx import Document
        from PIL import Image
        from agent.agents.bidding_agent.render.form_copier import (
            CopierUnsupported, extract_form_nodes)

        d = Document()
        d.add_paragraph("表单头")
        img = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(img, format="PNG")
        img.seek(0)
        d.add_picture(img)
        buf = io.BytesIO()
        d.save(buf)
        with pytest.raises(CopierUnsupported):
            extract_form_nodes(buf.getvalue(), FormSpan(0, 1, -1))


class TestGraft:
    def test_grafted_nodes_land_before_sectpr_and_keep_text(self):
        """嫁接进输出文档：文本与结构原样、sectPr 仍在文档末尾（插错位置 Word 打不开）。"""
        from docx import Document
        from agent.agents.bidding_agent.render.form_copier import (
            extract_form_nodes, graft_nodes)

        nodes = extract_form_nodes(_tender_docx(), FormSpan(1, 4, -1))
        out = Document()
        out.add_heading("供应商资格信用承诺函", level=1)
        graft_nodes(out, nodes)
        texts = [p.text for p in out.paragraphs]
        assert "致（采购人）：云上（江西）安全技术有限公司" in texts
        assert len(out.tables) == 1 and out.tables[0].cell(0, 0).text == "合计（大写）"
        body_tags = [el.tag.rsplit("}", 1)[-1] for el in out.element.body.iterchildren()]
        assert body_tags[-1] == "sectPr"


def _fill_docx() -> bytes:
    """填空形态大全（云上承诺函/情况一览表实测形状）：
    分离 run 空位、同 run 标签+空位、带括注标签、一行双空位、表格标签格。"""
    from docx import Document

    d = Document()
    p1 = d.add_paragraph()                                   # body#0 标签与空位分 run
    p1.add_run("单位名称：")
    blank = p1.add_run("________")
    blank.underline = True
    d.add_paragraph("统一社会信用代码（身份证号码）：______")     # body#1 同 run + 括注标签
    p3 = d.add_paragraph()                                   # body#2 一行双空位（后者无值）
    p3.add_run("联系电话：")
    p3.add_run("____")
    p3.add_run("　传真：")
    p3.add_run("____")
    t = d.add_table(rows=2, cols=2)                          # body#3 表格标签格
    t.cell(0, 0).text = "开户银行"
    t.cell(1, 0).text = "神秘字段"
    d.add_paragraph("项目名称：____")                          # body#4 项目信息白名单
    d.add_paragraph("我单位郑重承诺以上内容真实有效。")           # body#5 固定文字
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


_FIELDS = [("单位名称", "上海安几科技有限公司"),
           ("统一社会信用代码", "91310104MA1FRF3K3N"),
           ("联系电话", "021-52808586"),
           ("开户银行", "招商银行股份有限公司上海徐家汇支行")]


class TestFillBlanks:
    def _filled(self):
        from agent.agents.bidding_agent.render.form_copier import (
            extract_form_nodes, fill_blanks)
        nodes = extract_form_nodes(_fill_docx(), FormSpan(0, 5, -1))
        n = fill_blanks(nodes, _FIELDS, {"name": "云上零信任项目"})
        xml = "".join(__import__("lxml").etree.tostring(x, encoding="unicode") for x in nodes)
        return n, xml

    def test_known_labels_are_filled_and_formats_kept(self):
        """资料库有值的空位填上；分 run 空位保留原 run 格式（下划线还在=字写在横线上）。"""
        n, xml = self._filled()
        assert "上海安几科技有限公司" in xml
        assert "91310104MA1FRF3K3N" in xml                  # 同 run、带括注标签也认
        assert "021-52808586" in xml
        assert "招商银行股份有限公司上海徐家汇支行" in xml     # 表格标签格右侧
        assert "云上零信任项目" in xml                       # 项目信息白名单（meta.name）
        assert 'w:val="single"' in xml or "<w:u " in xml     # 下划线格式没被抹掉
        assert n == 5

    def test_unknown_blanks_stay_blank_and_fixed_text_untouched(self):
        """没值的空位原样留白（传真）；未知标签的表格格不填；固定文字一个字不动——绝不虚构。"""
        n, xml = self._filled()
        assert "传真：" in xml and xml.count("____") >= 1     # 传真的空位还在
        assert "神秘字段" in xml
        assert "我单位郑重承诺以上内容真实有效。" in xml
        import re as _re
        row = _re.search(r"神秘字段.*?</w:tr>", xml, _re.S).group(0)
        assert _re.sub(r"<[^>]+>", "", row).replace("神秘字段", "").strip() == ""

    def test_empty_fields_fill_nothing(self):
        from agent.agents.bidding_agent.render.form_copier import (
            extract_form_nodes, fill_blanks)
        nodes = extract_form_nodes(_fill_docx(), FormSpan(0, 5, -1))
        assert fill_blanks(nodes, [], {}) == 0


def _copier_tender() -> bytes:
    """带边界的招标 docx：承诺函（裸抬头边界）→ 内容 → 下一份表单抬头收段。"""
    from docx import Document

    d = Document()
    d.add_paragraph("供应商资格信用承诺函")
    d.add_paragraph("致（采购人）：云上（江西）安全技术有限公司")
    d.add_paragraph("单位名称：________")
    d.add_paragraph("我单位自愿参加本次采购询价活动并郑重承诺守信。")
    d.add_paragraph("供应商情况一览表")
    d.add_paragraph("供应商名称：________")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


class TestExportWiring:
    """T5 导出接线：pristine 表单章走复印机，手改章/偏离表/方案章让路，基线查不到整体让路。"""

    _CHAPTERS = {"b1": "<p>承诺函生成稿</p>", "b2": "<p>偏离表稿</p>", "t5": "<p>方案稿</p>"}
    _OUTLINE = {"chapters": [
        {"id": "b1", "title": "供应商资格信用承诺函", "group": "business"},
        {"id": "b2", "title": "技术偏离表", "group": "tech"},
        {"id": "t5", "title": "技术方案", "group": "tech"},
    ]}

    class _Ctx:
        thread_id = "proj-x"
        run_id = None          # 事件助手对 None 直接跳过，测试无需 recorder
        recorder = None
        agent_type = "bidding_agent"

    def _state(self):
        return {"chapters": dict(self._CHAPTERS),
                "read": {"project_meta": {"name": "云上零信任项目"}},
                "run_input": {"library_refs": {"company": [
                    {"body": "单位名称：上海安几科技有限公司"}]}}}

    def _run(self, monkeypatch, *, original=None, refs=None, state=None):
        import asyncio
        import agent.agents.bidding_agent.nodes.export as export_mod
        tender = _copier_tender()
        monkeypatch.setattr(export_mod, "_copier_baseline",
                            lambda tid: (original if original is not None else dict(self._CHAPTERS),
                                         refs if refs is not None else ["uploads/u/招标.docx"]))
        monkeypatch.setattr(export_mod.storage_read, "read_bytes", lambda k: tender)
        return asyncio.run(export_mod._copier_nodes(
            self._Ctx(), state or self._state(), self._OUTLINE))

    def test_pristine_form_chapter_is_copied_and_filled(self, monkeypatch):
        out = self._run(monkeypatch)
        assert set(out) == {"b1"}, "只有未手改的表单章走复印机（偏离表/方案章让路）"
        xml = "".join(__import__("lxml").etree.tostring(n, encoding="unicode") for n in out["b1"])
        assert "我单位自愿参加本次采购询价活动并郑重承诺守信。" in xml
        assert "上海安几科技有限公司" in xml            # 企业信息已由代码填进空位
        assert "供应商情况一览表" not in xml            # 下一份表单没被裹进来

    def test_edited_chapter_lets_the_html_route_win(self, monkeypatch):
        """用户手改过（当前 html ≠ 原始产物）→ 复印机让路，绝不静默覆盖手改。"""
        out = self._run(monkeypatch, original={**self._CHAPTERS, "b1": "<p>模型原稿</p>"})
        assert out == {}

    def test_non_docx_tender_disables_the_copier(self, monkeypatch):
        out = self._run(monkeypatch, refs=["uploads/u/招标.pdf"])
        assert out == {}

    def test_baseline_failure_falls_back_globally(self, monkeypatch):
        import asyncio
        import agent.agents.bidding_agent.nodes.export as export_mod

        def boom(tid):
            raise RuntimeError("pg down")
        monkeypatch.setattr(export_mod, "_copier_baseline", boom)
        out = asyncio.run(export_mod._copier_nodes(self._Ctx(), self._state(), self._OUTLINE))
        assert out == {}


class TestRenderIntegration:
    def test_render_docx_grafts_copier_chapter_instead_of_html(self):
        """copier_nodes 命中的章：招标原样 XML 进文档、该章 HTML 一个字不渲染；
        章标题照常；未命中章行为与从前逐字节一致（None 传参兼容由既有测试覆盖）。"""
        from docx import Document
        from agent.agents.bidding_agent.render.docx import render_docx
        from agent.agents.bidding_agent.render.form_copier import extract_form_nodes

        nodes = extract_form_nodes(_copier_tender(), FormSpan(0, 3, -1))
        outline = {"chapters": [{"id": "b1", "no": "第一章",
                                 "title": "供应商资格信用承诺函", "group": "business"}]}
        data = render_docx(outline, {"b1": "<p>HTML旧稿不该出现</p>"},
                           copier_nodes={"b1": nodes})
        doc = Document(io.BytesIO(data))
        texts = "\n".join(p.text for p in doc.paragraphs)
        assert "我单位自愿参加本次采购询价活动并郑重承诺守信。" in texts
        assert "单位名称：" in texts
        assert "HTML旧稿不该出现" not in texts
        assert "供应商资格信用承诺函" in texts
