"""分类知识注入（spec334 机制 / spec335 内容）。

本模块只提供**结构与注入函数**；两张表的内容由 spec335 按条验证后增补。
**表为空时两个函数返回空串**，全链路逐字节等同于未启用分类——管线因此可以独立上线、独立验收。

取主类别还是主次都取，规则只有一条：**产出「写什么」的取主类别，产出「查什么」的主次都取。**
写作侧两套并行会让标书结构和口径打架；检查侧多查一条只是多看一眼，漏一条是废标。
"""
from __future__ import annotations

CATEGORY_LABEL = {"goods": "货物", "services": "服务", "engineering": "工程"}

# 用途：chapters=必备章节（提纲） / planning=章节层面要点（正文规划轮） /
#       writing=落笔要点（正文子写手） / review=必查项（审查） / checklist=投递前核对项
PURPOSE_TITLE = {
    "chapters": "通行必备章节",
    "planning": "写作要点",
    "writing": "落笔要点",
    "review": "必查项",
    "checklist": "投递前核对项",
}

# 只有「查什么」的用途取主次两类；「写什么」的只取主类别
_BOTH_CATEGORIES = ("review", "checklist")

# 知识条目：{category, purpose, status, text}
#   status: "verified" 已核到现行法规原文或我们自己的真实标书 / "unverified" 仅行业通行做法
#   text:   **只写要求本身**，不写两份文案——措辞由下面的模板按 status 套，存两份会写漂
CATEGORY_KNOWLEDGE: list[dict] = []

# 行业资质补丁：{keywords, item, level, status}
#   命中 keywords 中任一词 ⇒ 追加一条 item。只做资质与陷阱，不做内容指导：
#   资质缺失是废标，且是模型从招标文件正文里推不出来的行业常识。
INDUSTRY_PATCHES: list[dict] = []

# 提纲注入的附加口径：类型清单只补漏，绝不越过招标文件
_CHAPTERS_NOTE = ("**招标文件构成清单已列出的以清单为准**；清单未提及、且提纲确实缺失的才补为独立章节。")

# 审查/审核表注入的附加口径：不写死这句，模型会把行业经验当成本次招标的明文要求，
# 刷出一堆招标文件根本没要求的「废标风险」——用户信错一次就再也不信体检报告了。
_REVIEW_NOTE = ("**以下是行业经验必查项，不是本次招标的明文要求**："
                "能对上招标条款的按高风险报，对不上的按中风险提醒。")


def _line(entry: dict) -> str:
    """按验证状态套措辞。未经核实的条目**不得以「必须」的口吻出现**——写手对「必须」是无条件
    服从的，一条错的必备章节会让每一本标书都多出一章不该有的内容，而用户看不出那是我们编的
    还是招标文件要求的。"""
    text = entry["text"]
    if entry.get("status") == "verified":
        return f"- 必须：{text}"
    return f"- 通常：{text}（请核对本次招标文件是否有此要求）"


def category_scope(categories: list[str] | None, purpose: str) -> str:
    """分类知识块。categories 为有效值（有序，首元素为主类别）；空或无匹配条目 ⇒ 返回空串。"""
    cats = [c for c in (categories or []) if c in CATEGORY_LABEL]
    if not cats:
        return ""
    take = cats if purpose in _BOTH_CATEGORIES else cats[:1]
    blocks: list[str] = []
    for cat in take:
        rows = [_line(e) for e in CATEGORY_KNOWLEDGE
                if e.get("category") == cat and e.get("purpose") == purpose]
        if not rows:
            continue
        note = _CHAPTERS_NOTE if purpose == "chapters" else (_REVIEW_NOTE if purpose in _BOTH_CATEGORIES else "")
        head = f"\n【{CATEGORY_LABEL[cat]}标 · {PURPOSE_TITLE.get(purpose, purpose)}】"
        blocks.append("\n".join([head + (f" {note}" if note else "")] + rows))
    return "\n".join(blocks)


def industry_patches(text: str) -> str:
    """行业资质补丁：在项目文本里做**字面**匹配（资质是精确术语，正是关键词擅长的场景）。
    未命中 ⇒ 空串。命中多条时按表内顺序输出，同一条只出一次。"""
    if not text:
        return ""
    rows = [f"- （{p.get('level', '中')}）{p['item']}"
            for p in INDUSTRY_PATCHES if any(k in text for k in p.get("keywords", []))]
    if not rows:
        return ""
    return "\n".join([f"\n【行业资质必查项】{_REVIEW_NOTE}"] + rows)
