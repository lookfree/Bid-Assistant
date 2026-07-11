import subprocess
from agent.agents.bidding_agent.render import pdf as pdf_mod


def test_docx_to_pdf_missing_binary_returns_none(monkeypatch):
    """本机没装 soffice（常见于本地开发机）→ 直接 None，不抛异常。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: None)
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") is None


def test_docx_to_pdf_uno_path_tried_first_and_used(monkeypatch):
    """UNO 脚本成功 → 用它的产物，不再落到 CLI 兜底。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")
    calls = []

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        calls.append(cmd)
        out_pdf = cmd[3]  # [_UNO_PYTHON, script, src, out_pdf, profile, port]
        with open(out_pdf, "wb") as f:
            f.write(b"%PDF-1.4 uno")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    result = pdf_mod.docx_to_pdf(b"fake docx bytes")
    assert result == b"%PDF-1.4 uno"
    assert len(calls) == 1
    assert calls[0][0] == pdf_mod._UNO_PYTHON


def test_docx_to_pdf_falls_back_to_cli_when_uno_fails(monkeypatch):
    """UNO 脚本失败（比如容器没装 python3-uno）→ 落到旧的 --convert-to 兜底路径。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")
    calls = []

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        calls.append(cmd)
        if cmd[0] == pdf_mod._UNO_PYTHON:
            raise subprocess.CalledProcessError(1, cmd)
        outdir = cmd[cmd.index("--outdir") + 1]
        with open(f"{outdir}/in.pdf", "wb") as f:
            f.write(b"%PDF-1.4 cli")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    result = pdf_mod.docx_to_pdf(b"fake docx bytes")
    assert result == b"%PDF-1.4 cli"
    assert len(calls) == 2
    assert calls[0][0] == pdf_mod._UNO_PYTHON
    assert "--convert-to" in calls[1]


def test_docx_to_pdf_uno_timeout_falls_back_to_cli(monkeypatch):
    """UNO 路径超时（soffice 监听没起来）→ 同样落到 CLI 兜底，而不是直接 None。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        if cmd[0] == pdf_mod._UNO_PYTHON:
            raise subprocess.TimeoutExpired(cmd, timeout)
        outdir = cmd[cmd.index("--outdir") + 1]
        with open(f"{outdir}/in.pdf", "wb") as f:
            f.write(b"%PDF-1.4 cli")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") == b"%PDF-1.4 cli"


def test_docx_to_pdf_uno_no_output_file_falls_back(monkeypatch):
    """UNO 声称成功但没产出文件（异常情况）→ 落到 CLI 兜底，而不是直接 None。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        if cmd[0] == pdf_mod._UNO_PYTHON:
            return subprocess.CompletedProcess(cmd, 0)  # 没写出 out_pdf
        outdir = cmd[cmd.index("--outdir") + 1]
        with open(f"{outdir}/in.pdf", "wb") as f:
            f.write(b"%PDF-1.4 cli")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") == b"%PDF-1.4 cli"


def test_docx_to_pdf_both_paths_fail_returns_none(monkeypatch):
    """UNO 和 CLI 都失败 → None，不崩。"""
    monkeypatch.setattr(pdf_mod.shutil, "which", lambda name: "/usr/bin/soffice")

    def fake_run(cmd, timeout=None, check=None, capture_output=None):
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(pdf_mod.subprocess, "run", fake_run)
    assert pdf_mod.docx_to_pdf(b"fake docx bytes") is None
