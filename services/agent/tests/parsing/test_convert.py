import os
import subprocess

import pytest

from agent.parsing import parsers
from agent.parsing.types import UnsupportedDocument


def _fake_run_writes(out_name: str, content: bytes):
    """造一个 subprocess.run 替身：不真跑 soffice，直接在 --outdir 落一个转换产物文件。"""
    def _fake(cmd, timeout=None, check=None, capture_output=None):
        outdir = cmd[cmd.index("--outdir") + 1]
        with open(os.path.join(outdir, out_name), "wb") as f:
            f.write(content)
        return subprocess.CompletedProcess(cmd, 0)
    return _fake


def test_convert_legacy_doc_success(monkeypatch):
    monkeypatch.setattr(parsers.shutil, "which", lambda name: "/usr/bin/soffice")
    monkeypatch.setattr(parsers.subprocess, "run", _fake_run_writes("input.docx", b"converted-bytes"))
    data, ext = parsers._convert_legacy(b"legacy doc bytes", "doc")
    assert ext == "docx"
    assert data == b"converted-bytes"


def test_convert_legacy_xls_success(monkeypatch):
    monkeypatch.setattr(parsers.shutil, "which", lambda name: "/usr/bin/soffice")
    monkeypatch.setattr(parsers.subprocess, "run", _fake_run_writes("input.xlsx", b"xlsx-bytes"))
    data, ext = parsers._convert_legacy(b"legacy xls bytes", "xls")
    assert ext == "xlsx"
    assert data == b"xlsx-bytes"


def test_convert_legacy_missing_soffice_raises():
    with pytest.raises(UnsupportedDocument):
        parsers._convert_legacy(b"x", "doc")


def test_convert_legacy_subprocess_failure_raises(monkeypatch):
    monkeypatch.setattr(parsers.shutil, "which", lambda name: "/usr/bin/soffice")

    def _fake(cmd, timeout=None, check=None, capture_output=None):
        raise subprocess.CalledProcessError(1, cmd)
    monkeypatch.setattr(parsers.subprocess, "run", _fake)
    with pytest.raises(UnsupportedDocument):
        parsers._convert_legacy(b"x", "xls")


def test_convert_legacy_timeout_raises(monkeypatch):
    monkeypatch.setattr(parsers.shutil, "which", lambda name: "/usr/bin/soffice")

    def _fake(cmd, timeout=None, check=None, capture_output=None):
        raise subprocess.TimeoutExpired(cmd, timeout or 60)
    monkeypatch.setattr(parsers.subprocess, "run", _fake)
    with pytest.raises(UnsupportedDocument):
        parsers._convert_legacy(b"x", "doc")


def test_convert_legacy_no_output_file_raises(monkeypatch):
    monkeypatch.setattr(parsers.shutil, "which", lambda name: "/usr/bin/soffice")
    monkeypatch.setattr(parsers.subprocess, "run",
                        lambda cmd, timeout=None, check=None, capture_output=None:
                        subprocess.CompletedProcess(cmd, 0))
    with pytest.raises(UnsupportedDocument):
        parsers._convert_legacy(b"x", "doc")


def test_dispatch_doc_converts_then_parses_docx(monkeypatch, docgen):
    docx_bytes = docgen.docx("legacy content")
    monkeypatch.setattr(parsers.shutil, "which", lambda name: "/usr/bin/soffice")
    monkeypatch.setattr(parsers.subprocess, "run", _fake_run_writes("input.docx", docx_bytes))
    doc = parsers.parse_bytes(b"legacy .doc bytes", "old.doc")
    assert doc.kind == "docx"
    assert "legacy content" in doc.text


def test_dispatch_xls_converts_then_parses_xlsx(monkeypatch, docgen):
    xlsx_bytes = docgen.xlsx()
    monkeypatch.setattr(parsers.shutil, "which", lambda name: "/usr/bin/soffice")
    monkeypatch.setattr(parsers.subprocess, "run", _fake_run_writes("input.xlsx", xlsx_bytes))
    doc = parsers.parse_bytes(b"legacy .xls bytes", "old.xls")
    assert doc.kind == "xlsx"
    assert "技术标" in doc.text


def test_dispatch_doc_missing_soffice_raises_unsupported(monkeypatch):
    monkeypatch.setattr(parsers.shutil, "which", lambda name: None)
    with pytest.raises(UnsupportedDocument):
        parsers.parse_bytes(b"legacy .doc bytes", "old.doc")
