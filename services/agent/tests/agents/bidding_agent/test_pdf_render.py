import subprocess
from agent.agents.bidding_agent.render import pdf as pdf_mod


def test_docx_to_pdf_missing_binary_returns_none(monkeypatch):
    """本机没装 soffice（常见于本地开发机）→ 直接 None，不抛异常。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: None)
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") is None


def test_docx_to_pdf_success_reads_output_file(monkeypatch, tmp_path):
    """soffice 转换成功：mock subprocess.run 并在 outdir 里落一个同名 .pdf 供函数读取。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        outdir = cmd[cmd.index("--outdir") + 1]
        with open(f"{outdir}/in.pdf", "wb") as f:
            f.write(b"%PDF-1.4 fake")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    result = pdf_mod.docx_to_pdf(b"fake docx bytes")
    assert result == b"%PDF-1.4 fake"


def test_docx_to_pdf_timeout_returns_none(monkeypatch):
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        raise subprocess.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") is None


def test_docx_to_pdf_subprocess_error_returns_none(monkeypatch):
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") is None


def test_docx_to_pdf_no_output_file_returns_none(monkeypatch):
    """soffice 声称成功但没产出文件（异常情况）→ None，不崩。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")
    monkeypatch.setattr(
        pdf_mod.subprocess, "run",
        lambda cmd, timeout=None, check=None, capture_output=None:
            subprocess.CompletedProcess(cmd, 0),
    )
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") is None
