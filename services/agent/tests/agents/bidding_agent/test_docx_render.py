import io
import zipfile
from docx import Document
from agent.agents.bidding_agent.render.docx import render_docx

# 1x1 透明 PNG，最小合法图片字节（spec325 测试专用）
_TINY_PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
             b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
             b"\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82")
# 1x1 红/绿 PNG：与 _TINY_PNG 内容不同，用于验证 python-docx 按内容去重时仍各自入 media
_TINY_PNG_RED = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02"
                 b"\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01"
                 b"\x01\x00\xc9\xfe\x92\xef\x00\x00\x00\x00IEND\xaeB`\x82")
_TINY_PNG_GREEN = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02"
                   b"\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc`\xf8\xcf\x00\x00\x02\x02"
                   b"\x01\x00{\t\x81x\x00\x00\x00\x00IEND\xaeB`\x82")


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


def test_render_docx_without_credentials_byte_identical():
    """spec325：不传 credentials（缺省 None）→ 输出与今天逐字节一致。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    without_kw = render_docx(outline, {"t1": "<p>正文</p>"})
    without_default = render_docx(outline, {"t1": "<p>正文</p>"}, credentials=None)
    assert without_kw == without_default


def test_render_docx_with_credentials_adds_appendix_and_media():
    """spec325：credentials 非空 → 追加「资格证明文件」附录（一级标题+条目二级标题），
    图片以 media 形式内嵌（word/media/ 计数与图片数一致）。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    credentials = [{"title": "营业执照", "images": [
        {"name": "license.png", "data": _TINY_PNG_RED},
        {"name": "license2.png", "data": _TINY_PNG_GREEN},
    ]}]
    data = render_docx(outline, {"t1": "<p>正文</p>"}, credentials=credentials)
    doc = Document(io.BytesIO(data))
    texts = [p.text for p in doc.paragraphs]
    assert "资格证明文件" in texts
    assert "营业执照" in texts
    zf = zipfile.ZipFile(io.BytesIO(data))
    media = [n for n in zf.namelist() if n.startswith("word/media/")]
    assert len(media) == 2


def test_render_docx_credential_image_fetch_failure_placeholder():
    """spec325：某图 data=None（取图失败）→ 该图占位一行「（图片加载失败：name）」，不崩，
    不影响其余图片正常内嵌。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    credentials = [{"title": "营业执照", "images": [
        {"name": "missing.png", "data": None},
        {"name": "license.png", "data": _TINY_PNG},
    ]}]
    data = render_docx(outline, {"t1": "<p>正文</p>"}, credentials=credentials)
    doc = Document(io.BytesIO(data))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "（图片加载失败：missing.png）" in texts
    zf = zipfile.ZipFile(io.BytesIO(data))
    media = [n for n in zf.namelist() if n.startswith("word/media/")]
    assert len(media) == 1


def test_render_docx_applies_bid_convention_styles():
    """标书排版惯例：正文宋体小四(12pt)、标题黑体加粗黑色（覆盖 Word 默认标题蓝）。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    data = render_docx(outline, {"t1": "<p>正文</p>"})
    doc = Document(io.BytesIO(data))
    normal = doc.styles["Normal"]
    assert normal.font.name == "宋体"
    assert normal.font.size.pt == 12
    assert normal.element.rPr.rFonts.get(
        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia"
    ) == "宋体"
    h1 = doc.styles["Heading 1"]
    assert h1.font.color.rgb == (0, 0, 0)
    assert h1.font.name == "黑体"
    assert h1.font.bold is True
    assert h1.font.size.pt == 16


def test_render_docx_appends_ai_generated_notice():
    """spec326 算法备案：导出文件末尾自动写入 AI 生成提示（长版文案，逐字不可改）。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    data = render_docx(outline, {"t1": "<p>正文</p>"})
    doc = Document(io.BytesIO(data))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert ("本内容由智启元投标助手生成合成类算法辅助生成，"
            "仅供投标文件编制参考，请结合招标文件原文和企业实际情况复核确认后使用。") in texts


def test_render_docx_credential_corrupt_image_placeholder():
    """spec325：图片字节损坏（add_picture 抛错）→ 占位一行，不崩，不影响导出。"""
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "T", "group": "tech"}]}
    credentials = [{"title": "资质证书", "images": [
        {"name": "bad.png", "data": b"not a real image"},
    ]}]
    data = render_docx(outline, {"t1": "<p>正文</p>"}, credentials=credentials)
    doc = Document(io.BytesIO(data))
    texts = "\n".join(p.text for p in doc.paragraphs)
    assert "（图片加载失败：bad.png）" in texts


def test_render_docx_embeds_inline_data_url_images():
    """编辑器插图（data URL 内嵌）要落进导出文件：裸 img 与 p 内嵌 img 都算；坏 base64 丢图保文。"""
    import base64
    src = "data:image/png;base64," + base64.b64encode(_TINY_PNG).decode()
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "方案", "group": "tech"}]}
    html = f'<p>拓扑如下：<img src="{src}"/></p><img src="{src}"/><img src="data:image/png;base64,@@bad@@"/>'
    data = render_docx(outline, {"t1": html})
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        media = [n for n in z.namelist() if n.startswith("word/media/")]
    assert len(media) >= 1  # 两张同内容图（python-docx 按内容去重）至少落一份；坏图被跳过未炸
    doc = Document(io.BytesIO(data))
    assert any("拓扑如下" in p.text for p in doc.paragraphs)  # 段落文字仍在


def test_render_docx_custom_format_applies(caplog):
    """spec330：传 fmt → A4 + 页边距 2.2/2.3、正文仿宋小四缩进2字符、标题字体字号加粗、1.5倍行距;
    改哪项覆盖哪项（body_font 覆盖为仿宋,其余走默认）。"""
    from docx.shared import Cm, Pt
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "方案", "group": "tech"}]}
    data = render_docx(outline, {"t1": "<p>正文</p>"}, fmt={"body_font": "仿宋"})
    doc = Document(io.BytesIO(data))
    sec = doc.sections[0]
    assert round(sec.page_width.cm, 1) == 21.0 and round(sec.page_height.cm, 1) == 29.7  # A4 纵向
    assert round(sec.top_margin.cm, 1) == 2.2 and round(sec.left_margin.cm, 1) == 2.3
    normal = doc.styles["Normal"]
    assert normal.font.name == "仿宋"                    # 覆盖项生效
    assert normal.font.size == Pt(12)                    # 默认小四
    assert normal.paragraph_format.first_line_indent == Pt(24)  # 首行缩进 2 字符 = 2×12pt
    assert normal.paragraph_format.line_spacing == 1.5
    h2 = doc.styles["Heading 2"]
    assert h2.font.name == "宋体" and h2.font.size == Pt(14) and h2.font.bold  # 标题默认宋体四号加粗
    assert h2.paragraph_format.first_line_indent == Pt(0)


def test_render_docx_without_fmt_keeps_legacy_styles():
    """不传 fmt：与现行样式一致（正文宋体12pt、标题黑体、默认页面）——旧路径零变化。"""
    from docx.shared import Pt
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "方案", "group": "tech"}]}
    doc = Document(io.BytesIO(render_docx(outline, {"t1": "<p>正文</p>"})))
    normal = doc.styles["Normal"]
    assert normal.font.name == "宋体" and normal.font.size == Pt(12)
    assert normal.paragraph_format.first_line_indent is None       # 旧路径不设缩进
    assert doc.styles["Heading 2"].font.name == "黑体"             # 旧路径标题黑体
