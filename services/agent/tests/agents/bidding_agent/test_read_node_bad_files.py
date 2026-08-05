"""文件本身有问题时，读标必须当场失败并说清原因——不能降级成误导性的模型报错。

2026-08-05 生产事故：一份被文档加密软件封装成密文的 .pdf 走到读标，pypdf 报「流意外结束」，
读标据此走「让模型自己调 parse_document」的兜底路径，模型连调三次工具全失败、第四轮改回纯文本，
最终抛出「模型未通过 submit_read_result 提交结构化结果」。四轮 token 白烧，报错还指向模型。

兜底路径本来是留给**瞬时错误**（MinIO/网络抖动）的二次机会，对坏文件毫无意义——同一个
read_and_parse 再跑一次结果一样。故按错误性质分流：瞬时的保留兜底，文件本身的当场失败。
"""
import asyncio

import pytest

from agent.agents.bidding_agent.nodes import read as read_mod
from agent.parsing.service import DocumentUnavailable
from agent.parsing.types import ParsedDoc, UnsupportedDocument
from agent.runtime.registry import RunContext

_OK = ParsedDoc(text="全文", kind="docx", clauses=[{"id": "sec-1-c1", "text": "项目名称：某平台"}])
_READ_ARGS = {"categories": [{"key": "overview", "title": "概况", "items": []}]}

_ENCRYPTED = UnsupportedDocument("文件已被文档加密软件封装成密文，请走解密/外发流程导出明文后重新上传")


def _ctx(gw):
    return RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)


def _files(*names):
    return [{"key": f"k/{n}", "name": n} for n in names]


def test_all_files_permanently_unparsable_fails_with_the_real_reason(monkeypatch, submit_gateway):
    """全部文件都是文件本身的问题 → 当场抛错，错误里带文件名和真实原因，且一次模型都不调。"""
    def boom(key):
        raise _ENCRYPTED

    monkeypatch.setattr(read_mod, "read_and_parse", boom)
    gw = submit_gateway({"submit_read_result": _READ_ARGS})
    state = {"file_key": "k/a.pdf", "files": _files("招标文件.pdf", "技术规范.pdf")}

    with pytest.raises(RuntimeError) as ei:
        asyncio.run(read_mod.make_read_node(_ctx(gw))(state))

    msg = str(ei.value)
    assert "招标文件.pdf" in msg and "技术规范.pdf" in msg
    assert "加密" in msg
    assert "submit_read_result" not in msg      # 绝不再把文件问题报成模型问题
    assert gw.chats == []                        # 没烧一轮 token


def test_one_good_file_is_enough_to_continue(monkeypatch, submit_gateway):
    """只要有一份能解析，照旧继续（坏的那份仍进 failed_files 告知用户）。"""
    def maybe(key):
        if key.endswith("坏的.pdf"):
            raise _ENCRYPTED
        return _OK

    monkeypatch.setattr(read_mod, "read_and_parse", maybe)
    gw = submit_gateway({"submit_read_result": _READ_ARGS})
    out = asyncio.run(read_mod.make_read_node(_ctx(gw))(
        {"file_key": "k/好的.docx", "files": _files("好的.docx", "坏的.pdf")}))

    assert [f["name"] for f in out["read"]["failed_files"]] == ["坏的.pdf"]
    assert out["read"]["failed_files"][0].keys() == {"name", "reason"}   # 不外泄内部分类字段
    assert gw.chats                                                       # 正常跑了读标


def test_transient_storage_failure_keeps_the_tool_fallback(monkeypatch, submit_gateway):
    """存储抖动是瞬时错误 → 保留兜底路径（让模型调 parse_document 再试），不当场失败。"""
    def flaky(key):
        raise DocumentUnavailable("读取文件失败: connection reset")

    monkeypatch.setattr(read_mod, "read_and_parse", flaky)
    gw = submit_gateway({"submit_read_result": _READ_ARGS})
    out = asyncio.run(read_mod.make_read_node(_ctx(gw))(
        {"file_key": "k/a.pdf", "files": _files("招标文件.pdf")}))

    assert out["read"]["categories"]      # 没抛错，走了兜底
    assert gw.chats


def test_single_file_path_also_fails_fast(monkeypatch, submit_gateway):
    """单文件路径（state 无 files）同样要当场失败——此前这条路把异常整个吞掉，连原因都没留。"""
    def boom(key):
        raise _ENCRYPTED

    monkeypatch.setattr(read_mod, "read_and_parse", boom)
    gw = submit_gateway({"submit_read_result": _READ_ARGS})

    with pytest.raises(RuntimeError) as ei:
        asyncio.run(read_mod.make_read_node(_ctx(gw))({"file_key": "k/招标文件.pdf"}))

    assert "加密" in str(ei.value)
    assert gw.chats == []


def test_single_file_transient_failure_keeps_fallback(monkeypatch, submit_gateway):
    """单文件路径的瞬时错误仍走兜底。"""
    def flaky(key):
        raise DocumentUnavailable("读取文件失败: timeout")

    monkeypatch.setattr(read_mod, "read_and_parse", flaky)
    gw = submit_gateway({"submit_read_result": _READ_ARGS})
    out = asyncio.run(read_mod.make_read_node(_ctx(gw))({"file_key": "k/a.pdf"}))

    assert out["read"]["categories"]
    assert gw.chats
