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


_FENCE = re.compile(r"```[a-zA-Z]*\n(.*?)```", re.S)
_FIRST_TAG = re.compile(r"<(?:h[1-6]|p|div|table|section|article|ul|ol|blockquote)\b", re.I)


def strip_chat_wrapper(text: str) -> str:
    """剥掉模型的对话式包装（2026-07-22 生产实测：改写输出带"好的，这是根据您的指令…"
    开场白 + ```html 围栏，整段被存进正文）。提示词已写"不加解释"但模型不可信，必须确定性兜底：
    ① 有 markdown 围栏 → 取最长围栏内容（模型把整章 HTML 包在围栏里）；
    ② 无围栏但正文前有闲聊 → 从首个块级 HTML 标签起截断前缀，并丢弃末个 '>' 之后的尾巴闲聊；
    纯 HTML 片段输入原样返回（幂等）。"""
    if not text:
        return text
    fences = _FENCE.findall(text)
    if fences:
        return max(fences, key=len).strip()
    m = _FIRST_TAG.search(text)
    if m and m.start() > 0:
        text = text[m.start():]
        tail = text.rfind(">")
        if tail != -1:
            text = text[: tail + 1]
    return text.strip()
