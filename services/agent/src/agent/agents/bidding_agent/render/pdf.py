from __future__ import annotations
import logging
import os
import shutil
import subprocess
import tempfile

logger = logging.getLogger(__name__)


def docx_to_pdf(docx_bytes: bytes) -> bytes | None:
    """.docx 字节 → .pdf 字节，走 agent 镜像自带的 LibreOffice headless（spec320 已装 soffice）。
    PDF 是 best-effort 附加工件：缺 soffice/超时/未产出文件，任何一种失败都只 warning 后返回
    None，绝不让导出节点因为 PDF 转换失败而崩掉（docx 是主产物，必须先稳）。"""
    if shutil.which("soffice") is None:
        logger.warning("docx→pdf 跳过：本机缺少 soffice")
        return None
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.docx")
        with open(src, "wb") as f:
            f.write(docx_bytes)
        try:
            # 每次转换独立 UserInstallation profile：与 parsing/parsers.py._convert_legacy 同理，
            # 默认 profile 有单实例锁，并发转换会互相拿不到锁而静默失败。
            profile = os.path.join(tmp, "lo-profile")
            subprocess.run(
                ["soffice", "--headless", f"-env:UserInstallation=file://{profile}",
                 "--convert-to", "pdf", "--outdir", tmp, src],
                timeout=120, check=True, capture_output=True,
            )
        except (subprocess.SubprocessError, OSError) as e:
            logger.warning("docx→pdf 转换失败: %s", e)
            return None
        out_path = os.path.join(tmp, "in.pdf")
        if not os.path.exists(out_path):
            logger.warning("docx→pdf 转换未产出文件")
            return None
        with open(out_path, "rb") as f:
            return f.read()
