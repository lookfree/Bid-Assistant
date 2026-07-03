import io
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
