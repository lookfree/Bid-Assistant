import agent.agents.bidding_agent.nodes.common as common_mod
from agent.agents.bidding_agent.nodes.common import parse_bid_chapters, parse_bid_docs
from agent.parsing.types import ParsedDoc


def _Parsed(clauses, pages=None, image_pages=0):
    return ParsedDoc(text="", kind="pdf", pages=pages, image_pages=image_pages, clauses=clauses)


def test_parse_bid_chapters_single_file_keeps_section_order(monkeypatch):
    """单文件（旧调用形状：传一个 key 的字符串）：按节聚合，正文原样成段。"""
    parsed = _Parsed([
        {"id": "sec-1-c1", "text": "总体方案"},
        {"id": "sec-1-c2", "text": "技术路线"},
        {"id": "sec-2-c1", "text": "服务承诺"},
        {"id": "no-sec-c9", "text": "没有节号的碎片"},  # 匹配不上 sec-N 的条目跳过
    ])
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: parsed)
    out = parse_bid_chapters("uploads/u/bid.docx")
    assert out == {"sec-1": "<p>总体方案</p><p>技术路线</p>", "sec-2": "<p>服务承诺</p>"}


def test_parse_bid_chapters_multi_file_renumbers_instead_of_overwriting(monkeypatch):
    """商务标与技术标分册上传：两份文件的节号都从 sec-1 起，直接合并会让后一份整节覆盖前一份
    （静默丢半本标书）。必须全局重排，且保持传入顺序。"""
    by_key = {
        "uploads/u/business.docx": _Parsed([
            {"id": "sec-1-c1", "text": "投标函"},
            {"id": "sec-2-c1", "text": "报价一览表"},
        ]),
        "uploads/u/tech.docx": _Parsed([
            {"id": "sec-1-c1", "text": "技术方案总述"},
            {"id": "sec-2-c1", "text": "实施组织"},
        ]),
    }
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: by_key[key])
    out = parse_bid_chapters(["uploads/u/business.docx", "uploads/u/tech.docx"])
    assert list(out) == ["sec-1", "sec-2", "sec-3", "sec-4"]  # 四节都在，无覆盖
    assert out["sec-1"] == "<p>投标函</p>" and out["sec-3"] == "<p>技术方案总述</p>"


def test_parse_bid_chapters_skips_files_that_yield_nothing(monkeypatch):
    """其中一份解析不出正文（如扫描件）：不占节号、不产空章；全都为空时返回空 dict，
    由节点层抛错转 run 失败（App 侧全额退款），绝不拿空文档去跑计费审查。"""
    by_key = {
        "a.pdf": _Parsed([]),
        "b.docx": _Parsed([{"id": "sec-1-c1", "text": "正文"}]),
    }
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: by_key[key])
    assert parse_bid_chapters(["a.pdf", "b.docx"]) == {"sec-1": "<p>正文</p>"}
    assert parse_bid_chapters(["a.pdf"]) == {}


async def test_parse_bid_docs_reports_only_files_with_scanned_pages(monkeypatch):
    """扫描图片页统计按文件回报（只回有图片页的那些），供审查诚实分级；
    全是可复制文字的文件不出现在统计里 → 审查提示词与此前一致。"""
    by_key = {
        "uploads/u/x/扫描件.pdf": _Parsed([{"id": "sec-1-c1", "text": "投标函"}],
                                       pages=366, image_pages=139),
        "uploads/u/x/正常.docx": _Parsed([{"id": "sec-1-c1", "text": "技术方案"}]),
    }
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: by_key[key])
    chapters, scanned = await parse_bid_docs(list(by_key))
    assert list(chapters) == ["sec-1", "sec-2"]
    assert scanned == [{"name": "扫描件.pdf", "pages": 366, "image_pages": 139}]


async def test_parse_bid_docs_feeds_ocr_text_into_the_chapters(monkeypatch):
    """扫描页识别成功后：识别文本进得了章节正文（参与后续切分与预算），该文件也不再出现在
    「看不见的页」统计里——注记随之消失。OCR 段本身见 tests/parsing/test_scanned_ocr.py。"""
    scanned_doc = _Parsed([{"id": "sec-1-c1", "text": "投标函"}], pages=3, image_pages=2)
    recognized = _Parsed([{"id": "sec-1-c1", "text": "投标函"},
                          {"id": "sec-1-c2", "text": "[第2页·扫描件识别]"},
                          {"id": "sec-1-c3", "text": "法定代表人身份证 张三"}],
                         pages=3, image_pages=0)
    seen = {}

    async def _fake_ocr(doc, key, on_progress=None):
        seen["key"] = key
        return recognized if doc is scanned_doc else doc

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: scanned_doc)
    monkeypatch.setattr(common_mod, "ocr_scanned_pages", _fake_ocr)
    chapters, scanned = await parse_bid_docs(["uploads/u/x/投标文件.pdf"])
    assert seen["key"] == "uploads/u/x/投标文件.pdf"
    assert scanned == []                                   # 全识别出来了 → 没有「看不见的页」
    assert "法定代表人身份证 张三" in chapters["sec-1"]
    assert "[第2页·扫描件识别]" in chapters["sec-1"]


def test_parse_bid_chapters_does_not_ocr(monkeypatch):
    """述标只要正文：不做扫描页 OCR——证照扫描页对讲标 PPT 没有信息量，
    却要花掉整份文件的识别时间（只有 review 那条路需要看见它们）。"""
    def _boom(*a, **kw):
        raise AssertionError("述标路径不该触发扫描页 OCR")

    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: _Parsed([{"id": "sec-1-c1", "text": "投标函"}],
                                            pages=366, image_pages=139))
    monkeypatch.setattr(common_mod, "ocr_scanned_pages", _boom)
    assert parse_bid_chapters("uploads/u/x/扫描件.pdf") == {"sec-1": "<p>投标函</p>"}
