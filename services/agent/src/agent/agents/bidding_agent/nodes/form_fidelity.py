"""表单章保真：模型只许填空，改没改原文由**代码**判，不靠提示词请求。

用户口径：招标给了格式的表单（响应函/授权书/报价表…），投标必须一模一样，「多一个字都不行」。
提示词里写「严禁自创格式」只是请求——2026-08-11 潍坊那单实测，招标 7 条固定条款被写成 6 条
全新措辞。所以这里把它变成**可判定的**：把模板切成固定片段，逐片检查是否原序出现在产出里，
任何一片对不上就丢弃产出、直接拿招标原文渲染。

什么算「可以变的」：
  · 下划线/长空白/点线 —— 本来就是留给投标人填的空
  · 括注占位（「（投标人名称）」「（盖章）」）—— 投标人要替换掉的占位符
其余每一个字都是固定文字。占位括注一律豁免是**故意放宽**：宁可漏判一处括注里的改写，
也不要因为模型正常地把「（投标人名称）」换成真名就把整章判死、退回一张空表。
"""

from __future__ import annotations

import html as html_mod
import re

# 空位：连续下划线（半/全角）、点线、长空白。三者都是纸质表单里「此处填写」的写法。
_BLANK = re.compile(r"[_＿]{2,}|[.．·]{4,}|[ \t　]{4,}")
# 占位括注：短括注才算占位，长括注多半是条款正文里的说明（如「（含税，大写与小写不一致时以大写为准）」）
_PLACEHOLDER = re.compile(r"[（(][^（）()]{0,14}[）)]")
_TAG = re.compile(r"<[^>]+>")
# 少于 6 个字的片段不作数：标点、编号、「致：」这类碎片到处都是，拿它们比对只会误判
_MIN_SEG = 6


def _norm(text: str) -> str:
    """比对用的归一化：去空白。HTML 重排（换行、缩进、标签内换行）不该被当成改写。"""
    return re.sub(r"\s+", "", text or "")


def _plain(html: str) -> str:
    """HTML → 纯文字（去标签 + 反转义实体）。表格改成 <td> 分列不算改写，字没变就行。"""
    return _norm(html_mod.unescape(_TAG.sub("", html or "")))


def fixed_segments(template: str) -> list[str]:
    """模板 → 必须原样保留的固定片段（按出现顺序），**逐行切**。

    为什么按行而不是把整份模板连成一条：连起来的话，模型在两行之间多写一个章标题
    （表单章本来就需要标题）就会让跨行的片段找不到，整章被判死、退回一张空表。
    保真机制天天误伤比不做还糟。按行切之后：改写、漏行、乱序照样逮得住，
    行与行之间插了别的东西则放过——插入远不如改写危险，而且肉眼一看就发现。
    """
    out: list[str] = []
    for line in (template or "").splitlines():
        marked = _PLACEHOLDER.sub("\x00", _BLANK.sub("\x00", line))
        out += [seg for raw in marked.split("\x00") if len(seg := _norm(raw)) >= _MIN_SEG]
    return out


def keeps_template(html: str, template: str) -> bool:
    """产出有没有原样保留模板的固定文字（顺序也要对）。

    顺序必须一起查：条款被打乱顺序重排，同样是「与招标格式不一致」。
    模板切不出任何固定片段（整份都是空位）时视为通过——没有可判定的东西，不该冤杀产出。
    """
    segments = fixed_segments(template)
    if not segments:
        return True
    hay = _plain(html)
    pos = 0
    for seg in segments:
        found = hay.find(seg, pos)
        if found < 0:
            return False
        pos = found + len(seg)
    return True


def _row_html(line: str) -> str:
    cells = "".join(f"<td>{html_mod.escape(c.strip())}</td>" for c in line.split("\t"))
    return f"<tr>{cells}</tr>"


def template_html(template: str, title: str = "") -> str:
    """招标模板原文 → 章正文 HTML（**零模型**）。制表符分列的行还原成表格行，其余成段。

    这是模型改写模板时的退路：交付一份**留着空位**的招标原格式，比交付一份措辞被改写、
    看着很完整的表单安全得多——后者要到评标现场才发现对不上。
    """
    out: list[str] = [f"<h3>{html_mod.escape(title)}</h3>"] if title else []
    rows: list[str] = []
    for line in (template or "").splitlines():
        if "\t" in line:
            rows.append(_row_html(line))
            continue
        if rows:
            out.append(f"<table>{''.join(rows)}</table>")
            rows = []
        if line.strip():
            out.append(f"<p>{html_mod.escape(line.strip())}</p>")
    if rows:
        out.append(f"<table>{''.join(rows)}</table>")
    return "".join(out)
