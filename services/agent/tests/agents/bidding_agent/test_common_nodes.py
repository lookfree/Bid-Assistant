import agent.agents.bidding_agent.nodes.common as common_mod
from agent.agents.bidding_agent.nodes.common import parse_bid_chapters


class _Parsed:
    def __init__(self, clauses):
        self.clauses = clauses


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
