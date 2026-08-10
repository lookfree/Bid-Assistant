import agent.agents.bidding_agent.nodes.common as common_mod
from agent.agents.bidding_agent.nodes.common import (
    html_to_review_text, parse_bid_chapters, parse_bid_docs)
from agent.agents.bidding_agent.nodes.present import _plain
from agent.parsing import ocr as ocr_mod
from agent.parsing.types import ParsedDoc


def _Parsed(clauses, pages=None, image_pages=0, embedded_images=0, headings=None):
    """image_pages 顺带造出逐页判定：「这份文件要不要真发 OCR」认的是 image_page_flags
    （scanned_page_indices），只填个数字的话惰性预算判据看不到有扫描页。"""
    total = pages or image_pages
    flags = [i >= total - image_pages for i in range(total)] if image_pages else []
    return ParsedDoc(text="", kind="pdf", pages=pages, image_pages=image_pages,
                     image_page_flags=flags, clauses=clauses, embedded_images=embedded_images,
                     headings=headings or [])


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


def test_clause_text_with_angle_brackets_survives_to_the_model(monkeypatch):
    """条款原文里的 < 和 > 必须原样走到模型手里。

    裸拼 `<p>{t}</p>` 的话，"响应时间<30分钟，可用率>99.9%" 里的 "<30分钟，可用率>" 就是一个
    像模像样的标签，下游剥标签时被整段吃掉——模型读到的是"响应时间99.9%"，SLA 承诺正好读反，
    审查/述标据此出结论。技术偏离表、服务承诺表里这种写法遍地都是。
    往回走的一跳同样要核：拼进去时转义了，喂模型前必须再还原，否则模型看到的是 "&lt;30分钟"。
    """
    clause = "响应时间<30分钟，可用率>99.9%"
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: _Parsed([{"id": "sec-1-c1", "text": clause}]))
    chapters = parse_bid_chapters("uploads/u/bid.docx")
    assert chapters["sec-1"] == "<p>响应时间&lt;30分钟，可用率&gt;99.9%</p>"
    assert html_to_review_text(chapters["sec-1"]) == clause      # 审查那条消费路
    assert _plain(chapters["sec-1"]) == clause                   # 述标那条消费路


async def test_chapter_titles_travel_with_their_own_section(monkeypatch):
    """章节标题必须**随该节正文一起**进入喂给模型的材料。

    标题另存 headings、不进 clauses 是解析层的口径；聚章只吃 clauses 的话，docx 认出几百条
    标题之后，模型拿到的反而是一堆没有名字的正文块——而用户的原始诉求正是「偏离表里明明
    写着的条款被判未响应」，「1.1.2 核心架构要求偏离表」这种标题恰恰是模型判断这段在答什么的
    唯一线索。审查与述标两条消费路都要看得见它。
    只有标题、没有正文的节仍不产章（既有口径）：那种节本来就没有可体检的内容。"""
    parsed = _Parsed([{"id": "sec-1-c1", "text": "本表逐条应答招标技术要求。"},
                      {"id": "sec-2-c1", "text": "3 身份集成：支持对接统一身份认证平台。"}],
                     headings=[{"sec": "sec-1", "title": "1.技术偏离表", "level": 1},
                               {"sec": "sec-2", "title": "1.1.2 核心架构要求偏离表", "level": 3},
                               {"sec": "sec-3", "title": "2.项目概况", "level": 1}])
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: parsed)
    chapters, _scanned = await parse_bid_docs(["uploads/u/技术文件.docx"])
    assert list(chapters) == ["sec-1", "sec-2"]          # 空标题节不产章
    text = html_to_review_text(chapters["sec-2"])        # 审查那条消费路
    assert text == "1.1.2 核心架构要求偏离表\n3 身份集成：支持对接统一身份认证平台。"
    assert _plain(chapters["sec-1"]).startswith("1.技术偏离表")   # 述标那条消费路


async def test_a_parent_title_travels_with_the_child_that_carries_its_text(monkeypatch):
    """父级标题（正文全在子节里、自己不产章）必须并进子节的标题。

    本次的样板文档就是这个形状：`1.技术偏离表` → `1.1 总体技术规范偏离表` →
    `1.1.2 核心架构要求偏离表`，正文只挂在最深那一层。只给叶子标题的话，模型不知道这段
    归属「技术偏离表」——与「把节名给模型」的目的正好相抵。
    自己有正文的父级不重复：它本来就自成一章，再抄一遍只是白花预算。"""
    parsed = _Parsed([{"id": "sec-3-c1", "text": "3 身份集成：支持对接统一身份认证平台。"},
                      {"id": "sec-4-c1", "text": "项目位于上海。"},
                      {"id": "sec-5-c1", "text": "工期 90 日历天。"}],
                     headings=[{"sec": "sec-1", "title": "1.技术偏离表", "level": 1},
                               {"sec": "sec-2", "title": "1.1 总体技术规范偏离表", "level": 2},
                               {"sec": "sec-3", "title": "1.1.2 核心架构要求偏离表", "level": 3},
                               {"sec": "sec-4", "title": "2.项目概况", "level": 1},
                               {"sec": "sec-5", "title": "2.1 工期", "level": 2}])
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: parsed)
    chapters, _scanned = await parse_bid_docs(["uploads/u/技术文件.docx"])
    assert (html_to_review_text(chapters["sec-1"]).splitlines()[0]
            == "1.技术偏离表 / 1.1 总体技术规范偏离表 / 1.1.2 核心架构要求偏离表")
    # 2.项目概况 自己有正文 → 自成一章，其子节只带自己的标题
    assert html_to_review_text(chapters["sec-2"]).splitlines()[0] == "2.项目概况"
    assert html_to_review_text(chapters["sec-3"]).splitlines()[0] == "2.1 工期"


def test_chapter_title_with_angle_brackets_is_escaped_like_the_body(monkeypatch):
    """标题走的是与条款原文同一套转义：「响应时间<30分钟」这类写法在标题里同样出现，
    裸拼的话下游剥标签时把半句话吃掉（同 test_clause_text_with_angle_brackets_survives）。"""
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: _Parsed([{"id": "sec-1-c1", "text": "全部满足。"}],
                                            headings=[{"sec": "sec-1", "level": 1,
                                                       "title": "3.2 响应时间<30分钟"}]))
    chapters = parse_bid_chapters("uploads/u/bid.docx")
    assert chapters["sec-1"] == "<h3>3.2 响应时间&lt;30分钟</h3><p>全部满足。</p>"
    assert html_to_review_text(chapters["sec-1"]) == "3.2 响应时间<30分钟\n全部满足。"


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

    async def _fake_ocr(doc, key, on_progress=None, deadline=None):
        seen["key"] = key
        return recognized if doc is scanned_doc else doc

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: scanned_doc)
    monkeypatch.setattr(common_mod, "ocr_scanned_pages", _fake_ocr)
    chapters, scanned = await parse_bid_docs(["uploads/u/x/投标文件.pdf"])
    assert seen["key"] == "uploads/u/x/投标文件.pdf"
    assert scanned == []                                   # 全识别出来了 → 没有「看不见的页」
    assert "法定代表人身份证 张三" in chapters["sec-1"]
    assert "[第2页·扫描件识别]" in chapters["sec-1"]


async def test_parse_bid_docs_shares_one_ocr_deadline_across_files(monkeypatch):
    """OCR 的时长帽是**一次审查**的，不是每份文件各一份：独立审查一次最多收 10 份标书，
    每份各开 20 分钟 → 最坏 200 分钟，用户在一个已预扣积分的步上干等几小时。
    故 deadline 建**一次**、原样传给后续每一份文件（第二份继承的是剩余预算）。"""
    seen: list[float | None] = []

    async def _fake_ocr(doc, key, on_progress=None, deadline=None):
        seen.append(deadline)
        return doc

    monkeypatch.setattr(ocr_mod.settings, "ocr_base_url", "http://ocr.test:8100")
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: _Parsed([{"id": "sec-1-c1", "text": "投标函"}],
                                            pages=9, image_pages=3))
    monkeypatch.setattr(common_mod, "ocr_scanned_pages", _fake_ocr)
    await parse_bid_docs(["uploads/u/x/一.pdf", "uploads/u/x/二.pdf"])
    assert len(seen) == 2
    assert seen[0] is not None and seen[0] == seen[1]     # 同一条 deadline，不是各开一份


class _Clock:
    """可推的单调时钟（换掉 parsing/ocr 里的 time，只影响该模块的取时）。"""

    def __init__(self):
        self.t = 0.0

    def monotonic(self) -> float:
        return self.t


async def test_ocr_budget_starts_at_the_first_real_ocr_not_at_download_time(monkeypatch):
    """20 分钟是**纯 OCR** 的预算，不含 MinIO 下载与解析。

    从循环前起算的话，10 份大文件的下载 + 解析（.doc 走 LibreOffice 转换，单份就能顶到 60s）
    先把预算啃掉，第一次识别还没发出去就报「OCR 预算已用光」——张冠李戴，用户以为识别超时，
    真相是时间花在了取文件上。故 deadline **惰性起算**：第一份真要发 OCR 的文件到手时才建。"""
    clock = _Clock()
    monkeypatch.setattr(ocr_mod, "time", clock)
    monkeypatch.setattr(ocr_mod.settings, "ocr_base_url", "http://ocr.test:8100")
    docs = {
        "uploads/u/x/纯文本.pdf": _Parsed([{"id": "sec-1-c1", "text": "正文"}], pages=9),
        "uploads/u/x/扫描件.pdf": _Parsed([{"id": "sec-1-c1", "text": "投标函"}],
                                       pages=9, image_pages=3),
    }
    seen: list[tuple[str, float | None]] = []

    def _read(key):
        clock.t += 25 * 60          # 下载 + 解析先花掉 25 分钟（比整条预算还长）
        return docs[key]

    async def _fake_ocr(doc, key, on_progress=None, deadline=None):
        seen.append((key.rsplit("/", 1)[-1], deadline))
        return doc

    monkeypatch.setattr(common_mod, "read_and_parse", _read)
    monkeypatch.setattr(common_mod, "ocr_scanned_pages", _fake_ocr)
    await parse_bid_docs(list(docs))
    assert seen[0] == ("纯文本.pdf", None)          # 没有扫描页 → 一秒预算都不起算
    # 轮到真要识别的那份时，预算还是完整的 20 分钟（不是被下载解析吃剩的负数）
    assert seen[1][0] == "扫描件.pdf"
    assert seen[1][1] == clock.t + ocr_mod._TOTAL_BUDGET_S


async def test_parse_bid_docs_owns_up_to_images_embedded_in_a_docx(monkeypatch):
    """docx 里贴的证照/盖章图解析后一个字都不留：必须像扫描页一样进「看不见」统计，
    否则 docx 版标书照旧被判「缺少」——治理只覆盖了 PDF，docx 直接回归。
    没有「页」的口径，只能报张数（见 ParsedDoc.embedded_images）。"""
    by_key = {
        "uploads/u/x/商务标.docx": _Parsed([{"id": "sec-1-c1", "text": "投标函"}],
                                        embedded_images=4),
        "uploads/u/x/技术标.docx": _Parsed([{"id": "sec-1-c1", "text": "技术方案"}]),
    }
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: by_key[key])
    _chapters, scanned = await parse_bid_docs(list(by_key))
    assert scanned == [{"name": "商务标.docx", "embedded_images": 4}]


async def test_a_legacy_doc_with_images_does_not_start_the_ocr_budget(monkeypatch):
    """`.doc` 里的内嵌图这条链路根本不识别（识别侧只吃 .docx），就不该为它起 20 分钟的表。

    起表判据与「真会发请求」的判据必须同口径：首份是 .doc、后面跟着 9 份大 PDF 时，预算会被
    它之后的下载啃掉，第一次识别还没发出去就报「预算已用光」——张冠李戴。"""
    seen: list[float | None] = []

    async def _fake_ocr(doc, key, on_progress=None, deadline=None):
        seen.append(deadline)
        return doc

    monkeypatch.setattr(ocr_mod.settings, "ocr_base_url", "http://ocr.test:8100")
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: _Parsed([{"id": "sec-1-c1", "text": "投标函"}],
                                            embedded_images=5))
    monkeypatch.setattr(common_mod, "ocr_scanned_pages", _fake_ocr)
    monkeypatch.setattr(common_mod, "ocr_docx_images", _fake_ocr)
    await parse_bid_docs(["uploads/u/x/商务标.doc"])
    assert seen == [None, None]           # 两条链路都拿到「还没起表」


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
