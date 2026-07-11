"""章节 HTML 清洗（e2e 实测缺陷）：模型无视"只输出片段"指令，把整章写成完整 HTML 文档
（<!DOCTYPE><html><head><style>body{max-width/margin/padding...}</style>...）。
前端 dangerouslySetInnerHTML 渲染时 <style> 泄漏劫持全页布局（整站被限宽居中"变形"）；
docx 渲染时 head/style 文本会被当正文吐出。收稿与渲染入口统一过此清洗。"""
from __future__ import annotations
import re

_HEAD = re.compile(r"<head[\s>].*?</head>", re.I | re.S)
_STYLE = re.compile(r"<style[\s>].*?</style>", re.I | re.S)
_SCRIPT = re.compile(r"<script[\s>].*?</script>", re.I | re.S)
_META_TITLE = re.compile(r"<meta[^>]*>|<title[^>]*>.*?</title>", re.I | re.S)
_SHELL = re.compile(r"<!DOCTYPE[^>]*>|</?(?:html|body)[^>]*>", re.I)


def strip_document_shell(html: str) -> str:
    """剥掉文档壳与全局样式，只留正文片段；纯片段输入原样返回（幂等）。"""
    if not html:
        return html
    out = _HEAD.sub("", html)
    out = _STYLE.sub("", out)
    out = _SCRIPT.sub("", out)
    out = _META_TITLE.sub("", out)
    out = _SHELL.sub("", out)
    return out.strip()
