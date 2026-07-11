import io
import zipfile
from docx import Document
from agent.agents.bidding_agent.render.docx import render_docx


def test_render_docx_assembles_chapters():
    outline = {"chapters": [
        {"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"},
        {"id": "b3", "no": "第三章", "title": "商务报价", "group": "business"},
        {"id": "t5", "no": "第五章", "title": "应急预案", "group": "tech"},  # 无正文 → 占位
    ]}
    chapters = {"t1": "<h3>1.1 需求理解</h3><p>政务云运维…</p><ul><li>7×24</li></ul>",
                "b3": "<h3>3.1 报价</h3><p>1560 万元</p><table><tr><th>项</th><th>金额</th></tr><tr><td>运维</td><td>1560</td></tr></table>"}
    data = render_docx(outline, chapters, meta={"name": "某市政务云运维 投标文件", "buyer": "某市大数据局"})
    assert data[:2] == b"PK"
    doc = Document(io.BytesIO(data))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "某市政务云运维 投标文件" in texts
    assert "（本章正文待生成）" in texts          # t5 无正文 → 占位
    assert "7×24" in texts                         # 列表项进入 docx
    assert doc.tables and doc.tables[0].rows[1].cells[0].text == "运维"   # 表格映射


def test_render_docx_handles_ragged_table_and_container():
    """模型产出不规整时不崩：表格行列参差取最大列数；div 包裹递归展开不压扁。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    chapters = {"t1": "<div><h3>标题</h3><p>正文</p>"
                      "<table><tr><td>a</td></tr><tr><td>b</td><td>c</td></tr></table></div>"}
    data = render_docx(outline, chapters)
    doc = Document(io.BytesIO(data))
    texts = [p.text for p in doc.paragraphs]
    assert "标题" in texts and "正文" in texts        # div 内结构保留（各自成段）
    assert doc.tables[0].rows[1].cells[1].text == "c"  # 参差行不越界


def test_render_docx_has_real_toc_and_page_number_fields():
    """spec323：目录不是静态文本而是真域（Word 打开按 F9 更新）；页脚是居中 PAGE 域页码。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    data = render_docx(outline, {"t1": "<p>正文</p>"}, meta={"name": "某项目 投标文件"})
    zf = zipfile.ZipFile(io.BytesIO(data))
    document_xml = zf.read("word/document.xml").decode("utf-8")
    footer_xml = "".join(
        zf.read(n).decode("utf-8") for n in zf.namelist() if n.startswith("word/footer")
    )
    header_xml = "".join(
        zf.read(n).decode("utf-8") for n in zf.namelist() if n.startswith("word/header")
    )
    assert 'TOC \\o "1-3" \\h \\z \\u' in document_xml     # 真 TOC 域 instrText
    assert "在 Word 中按 F9 更新目录" in document_xml       # 保留人工提示文案
    assert "PAGE" in footer_xml                            # 页脚 PAGE 域
    assert "某项目 投标文件" in header_xml                  # 页眉=项目名


def test_render_docx_without_package_byte_identical():
    """spec324：不传 package（未选包/单包）→ 输出与今天逐字节一致（无「包件：」行）。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    meta = {"name": "某项目 投标文件", "buyer": "某局"}
    without_kw = render_docx(outline, {"t1": "<p>正文</p>"}, meta=meta)
    without_default = render_docx(outline, {"t1": "<p>正文</p>"}, meta=meta, package=None)
    assert without_kw == without_default
    doc = Document(io.BytesIO(without_kw))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "包件：" not in texts


def test_render_docx_with_package_adds_cover_line():
    """spec324：package 存在 → 封面项目名下加「包件：《name》」一行。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    meta = {"name": "某项目 投标文件", "buyer": "某局"}
    data = render_docx(outline, {"t1": "<p>正文</p>"}, meta=meta,
                        package={"id": "p1", "name": "实网攻防"})
    doc = Document(io.BytesIO(data))
    texts = [p.text for p in doc.paragraphs]
    assert "包件：《实网攻防》" in texts
    assert texts.index("包件：《实网攻防》") < texts.index("采购人：某局")  # 位于项目名之下、其它信息之上
