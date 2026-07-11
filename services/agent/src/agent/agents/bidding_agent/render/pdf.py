from __future__ import annotations
import logging
import os
import shutil
import subprocess
import tempfile

logger = logging.getLogger(__name__)

# Debian 的 python3-uno 把 uno 绑定装在系统 python3（/usr/bin/python3），不是本服务
# uv 管理的虚拟环境——venv 里 import uno 会失败，必须显式用系统解释器跑 UNO 脚本。
_UNO_PYTHON = "/usr/bin/python3"

# 一次性 UNO 脚本：自己拉起一个 headless soffice 监听实例、等待就绪、加载 docx、
# 强制刷新并更新目录域（document.refresh() 只刷普通域，TOC/索引类域必须单独
# getDocumentIndexes()[i].update()——这正是纯 CLI --convert-to 转出的 PDF 目录页是
# 空占位的原因）、导出 PDF、关闭文档、结束监听进程。整段逻辑打包成一个脚本文件，
# 由 docx_to_pdf 用一次 subprocess.run 调用；每次转换起自己独立的监听端口/profile，
# 天然规避并发转换互相抢监听端口或 profile 锁的问题。
_UNO_SCRIPT = '''\
import subprocess
import sys
import time
import pathlib

import uno
from com.sun.star.beans import PropertyValue


def _prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def _file_url(path):
    return pathlib.Path(path).resolve().as_uri()


def main():
    in_path, out_path, profile_dir, port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    listener = subprocess.Popen([
        "soffice", "--headless", "--invisible", "--norestore",
        f"-env:UserInstallation=file://{profile_dir}",
        f"--accept=socket,host=127.0.0.1,port={port};urp;",
    ])
    try:
        local_ctx = uno.getComponentContext()
        resolver = local_ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", local_ctx)
        ctx = None
        for _ in range(60):
            try:
                ctx = resolver.resolve(
                    f"uno:socket,host=127.0.0.1,port={port};urp;StarOffice.ComponentContext")
                break
            except Exception:
                time.sleep(0.5)
        if ctx is None:
            raise RuntimeError("soffice UNO 监听未就绪")
        smgr = ctx.ServiceManager
        desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        doc = desktop.loadComponentFromURL(
            _file_url(in_path), "_blank", 0, (_prop("Hidden", True),))
        try:
            doc.refresh()
            indexes = doc.getDocumentIndexes()
            for i in range(indexes.getCount()):
                indexes.getByIndex(i).update()
            doc.storeToURL(_file_url(out_path), (_prop("FilterName", "writer_pdf_Export"),))
        finally:
            doc.close(False)
    finally:
        listener.terminate()
        try:
            listener.wait(timeout=10)
        except subprocess.TimeoutExpired:
            listener.kill()


if __name__ == "__main__":
    main()
'''


def _convert_via_uno(src: str, out_pdf: str, tmp: str) -> bytes | None:
    """首选路径：见 _UNO_SCRIPT 顶部注释——会真正更新目录域。任何失败（缺
    python3-uno、UNO 连接失败、脚本异常）都只 warning，交给调用方走 CLI 兜底。"""
    script_path = os.path.join(tmp, "uno_convert.py")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(_UNO_SCRIPT)
    profile = os.path.join(tmp, "lo-profile-uno")
    try:
        subprocess.run(
            [_UNO_PYTHON, script_path, src, out_pdf, profile, "2002"],
            timeout=120, check=True, capture_output=True,
        )
    except (subprocess.SubprocessError, OSError) as e:
        logger.warning("UNO docx→pdf 转换失败: %s", e)
        return None
    if not os.path.exists(out_pdf):
        logger.warning("UNO docx→pdf 转换未产出文件")
        return None
    with open(out_pdf, "rb") as f:
        return f.read()


def _convert_via_cli(src: str, tmp: str) -> bytes | None:
    """兜底路径（旧行为）：直接 --convert-to pdf。不会更新目录域，但比完全没有 PDF
    强——UNO 路径失败时用它保证 PDF 仍然产出。"""
    try:
        # 每次转换独立 UserInstallation profile：默认 profile 有单实例锁，并发转换
        # 会互相拿不到锁而静默失败（与 parsing/parsers.py._convert_legacy 同理）。
        profile = os.path.join(tmp, "lo-profile-cli")
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


def docx_to_pdf(docx_bytes: bytes) -> bytes | None:
    """.docx 字节 → .pdf 字节，走 agent 镜像自带的 LibreOffice headless（spec320 已装 soffice）。
    优先走 UNO 脚本（_convert_via_uno，会真正更新目录域），失败时回退到旧的 CLI 直转
    （_convert_via_cli，仍能产出 PDF，只是目录域不刷新）。PDF 是 best-effort 附加工件：
    缺 soffice/两条路径都失败，任何一种失败都只 warning 后返回 None，绝不让导出节点
    因为 PDF 转换失败而崩掉（docx 是主产物，必须先稳）。"""
    if shutil.which("soffice") is None:
        logger.warning("docx→pdf 跳过：本机缺少 soffice")
        return None
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.docx")
        with open(src, "wb") as f:
            f.write(docx_bytes)
        out_pdf = os.path.join(tmp, "uno_out.pdf")
        result = _convert_via_uno(src, out_pdf, tmp)
        if result is not None:
            return result
        logger.warning("UNO 转换失败，回退到 CLI 直转（目录域不会更新）")
        return _convert_via_cli(src, tmp)
