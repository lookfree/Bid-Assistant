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


_FENCE = re.compile(r"```[a-zA-Z]*\r?\n?(.*?)```", re.S)
_ANY_TAG = re.compile(r"<[a-zA-Z][^>]*>")
# 明显的闲聊句式（开场白/收尾语）。只有命中这些才动刀——判不准一律保留：
# 闲聊残留只是难看，误删正文是丢用户付费内容的事故（审查实测原实现四种误删场景）。
_CHAT_PREFIX = re.compile(r"^(好的|以下|已按|根据您|这是|如下|收到|修改点|变更说明)")
_CHAT_TAIL = re.compile(r"^(以上|请查收|如需|希望|说明|注[:：]|修改之处|如有)")


def strip_chat_wrapper(text: str) -> str:
    """剥掉模型的对话式包装（2026-07-22 生产实测：改写输出带"好的，这是根据您的指令…"
    开场白 + ```html 围栏，整段被存进正文）。提示词已写"不加解释"但模型不可信，必须确定性兜底。
    设计原则：**宁留勿删**——只删有明确闲聊特征的包装，判不准原样保留。
    ① 有围栏：拼接所有含 HTML 标签的围栏段（模型可能把整章拆进多段围栏，全都要）；
       若没有任何围栏段含标签（模型只把旁白围了起来），删掉围栏段后按 ②③ 处理剩余文本。
    ② 前缀：首个 '<' 之前的纯文本命中闲聊句式才截掉，否则保留（裸文本标题开头是合法正文）。
    ③ 尾巴：末个 '>' 之后的纯文本命中闲聊句式才截掉，否则保留（落款等裸文本结尾是合法正文）。
    纯 HTML 片段输入原样返回（幂等）。"""
    if not text:
        return text
    fences = _FENCE.findall(text)
    html_fences = [f.strip() for f in fences if _ANY_TAG.search(f)]
    if html_fences:
        return "\n".join(html_fences)
    if fences:
        text = _FENCE.sub("", text)  # 围栏里全是旁白 → 连围栏带内容删掉，剩余文本继续清洗
    head = text.find("<")
    if head > 0 and _CHAT_PREFIX.search(text[:head].strip()):
        text = text[head:]
    tail = text.rfind(">")
    if tail != -1 and _CHAT_TAIL.search(text[tail + 1 :].strip()):
        text = text[: tail + 1]
    return text.strip()
