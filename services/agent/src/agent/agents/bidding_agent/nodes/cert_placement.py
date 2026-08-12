"""证照定向插章 post-pass（2026-08-09 资料库定向注入设计,计划③）：招标要求命中证照词表
× 章定位（clause_ids 交集，同 content.py 的 _requirements_lines 手法）× 资料库库存 三重命中，
章尾追加"见下图"占位图，或库无时追加"待补充"提示——不再赌 RAG 召回率把证照插对章。

**在缓存读写之外单独跑**：run_content_pipeline 收尾处 out 构建完（fresh 章刚写完 / 缓存章
刚命中）之后立即现算一遍，绝不写回 Redis 缓存——缓存里恒久存的是模型原稿，插图逻辑每轮
都按资料库当前状态重新决定，库存增删（用户在资料库加/删证照）下一轮立即生效，不必等提示词
版本哈希失效才能刷新占位图。

构建全程零 LLM：纯字符串拼接，与 credentials_chapter.py 的零 LLM 保证同一手法（审查专项：
证照条目/图片量不设上限，一旦有字符经过模型，会把简报顶穿上下文并白白计费）。
"""
from __future__ import annotations

import re

from agent.agents.bidding_agent.nodes.common import filter_read_by_package
from agent.agents.bidding_agent.nodes.content import _collect_clause_ids
from agent.agents.bidding_agent.nodes.credentials_chapter import SYS_CREDS_ID, _esc, _image_alt

# 证照词表字面量——与计划 Global Constraints、web 侧 lib/cert-keywords.ts 逐字同形（两端各自
# 持有确定性实现,字面量一改就要同步改另一处，注释互指）。
# 证照词组：每组 = (标准名, 该组的全部写法…)。**匹配用组内任一写法，展示用标准名。**
# 为什么不是一张平表（2026-08-11 用户实测两次踩空）：平表要求"招标要求的措辞"与"用户给条目
# 起的名字"命中同一个词——「法人身份证」对不上「法定代表人身份证明」、「公司执照」对不上
# 「营业执照」，材料躺在库里却插不进标书。归组后两侧各自用自己的习惯说法即可。
# 与 web 侧 lib/cert-keywords.ts 逐字同形（两端各自持有确定性实现，一改就要同步改另一处）。
CERT_GROUPS: tuple[tuple[str, ...], ...] = (
    ("营业执照", "营业执照", "工商执照", "公司执照", "营业执照副本", "三证合一"),
    ("资质证书", "资质证书", "资质证明", "企业资质", "等级证书"),
    ("授权书", "授权书", "授权委托书", "法定代表人授权书", "原厂授权", "厂家授权"),
    ("法定代表人身份证明", "法定代表人身份证明", "法定代表人身份证", "法人身份证明",
     "法人身份证", "法人代表身份证", "法定代表人证明书"),
    ("检测证书", "检测证书", "检测报告", "检验报告", "型式试验"),
    ("许可证", "许可证", "经营许可"),
    ("审计报告", "审计报告", "审计意见", "经审计的财务"),
    ("资产负债表", "资产负债表"),
    ("利润表", "利润表", "损益表"),
    ("财务报表", "财务报表", "财务状况", "财务报告"),
    ("纳税证明", "纳税证明", "完税证明", "纳税记录", "税收缴纳"),
    ("社保证明", "社保证明", "社会保险", "社保缴纳"),
    ("银行资信证明", "银行资信证明", "资信证明", "银行资信"),
    ("开户许可证", "开户许可证", "基本账户", "开户证明"),
)

# 标准名列表（展示用，也是双端同表断言的锚点）。
CERT_KEYWORDS: tuple[str, ...] = tuple(g[0] for g in CERT_GROUPS)


def _group_of(text: str) -> str | None:
    """一段文字命中哪一组 → 返回该组标准名；都不命中返回 None。取**最长**的匹配写法所在组，
    避免「开户许可证」同时命中「许可证」组（包含关系）。"""
    best: tuple[int, str] | None = None
    for group in CERT_GROUPS:
        for alias in group[1:]:
            if alias in text and (best is None or len(alias) > best[0]):
                best = (len(alias), group[0])
    return best[1] if best else None


def _aliases_of(canonical: str) -> tuple[str, ...]:
    """标准名 → 该组全部写法（查库存时任一写法命中即算这份材料）。"""
    return next((g[1:] for g in CERT_GROUPS if g[0] == canonical), (canonical,))


# post-pass 定位只看 read 结论里资格/商务两类条目——技术类要求命中证照字样极罕见且易误报。
_CERT_CATEGORY_KEYS = ("qualification", "commercial")
# `_image_alt`（标题|ocrText 截前 120 字）现收在 credentials_chapter.py：附录章占位图 alt
# 与本文件的章内插图 alt 是同一套格式（终审 I-4），不再各自持有一份实现。


def _cert_block(keyword: str, entry: dict | None) -> str:
    """单个证照词命中后的章尾追加块：库有该词对应条目 → 见下图 + 该条目逐图占位
    （三属性同 credentials_chapter.py 的 build_credentials_chapter,无 src 无字节）；
    库无 → 待补充提示。"""
    if entry is None:
        return f"<p>（待补充：{_esc(keyword)}）</p>"
    title = str(entry.get("title") or "").strip()
    parts = [f"<p>【{_esc(keyword)}】见下图：</p>"]
    for img in entry.get("images") or []:
        file_id = _esc(img.get("fileId"))
        key = _esc(img.get("key"))
        alt = _image_alt(title, img.get("ocrText"))
        parts.append(f'<p><img data-file-id="{file_id}" data-object-key="{key}" alt="{alt}" /></p>')
    return "\n".join(parts)


# 证据词：段落锚点必须带其一。「响应函里顺嘴提到营业执照」不是要材料的地方，
# 「附：全权代表人和法定代表人身份证原件扫描件」才是——不带证据词的散文提及一律不挂图。
_EVIDENCE = re.compile(r"扫描件|原件|复印件|证明材料|加盖公章")
_ANCHOR = re.compile(r"<(h[3-6]|p)[^>]*>(.*?)</\1>", re.S)
_TAG = re.compile(r"<[^>]+>")
_TABLE_SPAN = re.compile(r"<table\b.*?</table>", re.S | re.I)


def _anchor_end(html: str, aliases: tuple[str, ...]) -> int:
    """章 HTML 里第一处能挂靠该证照的位置（锚元素闭合处的偏移）：
    小节标题（h3-h6）内文含组内任一写法即算（「一、营业执照副本扫描件」）；
    普通段落还须同时含证据词（授权书表单的「附：…身份证原件扫描件」）。找不到 -1。
    表格内的提及一律不算锚（评审表/资格要求表里满是「提供营业执照扫描件」）：
    插进 <td> 的占位图渲染层会整个丢掉（_emit_table 只取文字），而 html 里已出现
    data-file-id 又会让附录把它滤掉——材料在正文和附录**两头消失**。"""
    tables = [(t.start(), t.end()) for t in _TABLE_SPAN.finditer(html or "")]
    for m in _ANCHOR.finditer(html or ""):
        if any(s <= m.start() < e for s, e in tables):
            continue
        text = _TAG.sub("", m.group(2))
        if any(a in text for a in aliases):
            if m.group(1) != "p" or _EVIDENCE.search(text):
                return m.end()
    return -1


def _place_by_anchor(result: dict[str, str], ordered_cids: list[str],
                     credentials: list[dict], placed: set[int]) -> None:
    """定向就位（2026-08-12 云上江西用户反馈）：营业执照图要在「营业执照副本扫描件」
    小节底下、法人身份证要在授权书「附：…身份证原件扫描件」那行底下——不是全堆附录。
    按章序扫锚点，每个条目全局只放**第一处**：五个章都提营业执照时只进最先对口的那章，
    重复插图既撑大文件也让评委翻到哪都是同一张执照。placed 由调用方共享，
    章尾追加与附录构建据此去重。原地更新 result。"""
    for cid in ordered_cids:
        html = result.get(cid)
        if not html:
            continue
        for entry in credentials:
            if id(entry) in placed or not entry.get("images"):
                continue
            group = _group_of(str(entry.get("title") or ""))
            if group is None:
                continue
            pos = _anchor_end(html, _aliases_of(group))
            if pos < 0:
                continue
            html = html[:pos] + "\n" + _cert_block(group, entry) + html[pos:]
            placed.add(id(entry))
        result[cid] = html


def _matched_keywords(read: dict, clause_ids: set[str]) -> list[str]:
    """本章命中的证照词（去重,保持词表序）：资格/商务类条目 title 命中词表某词,且该条目
    clause_ids 与本章子项 clause_ids（调用方传入）有交集——定位手法与 content.py 的
    _requirements_lines / _chapter_requirements 同源（_collect_clause_ids）。"""
    if not clause_ids:
        return []
    hit_titles: list[str] = []
    for cat in read.get("categories") or []:
        if cat.get("key") not in _CERT_CATEGORY_KEYS:
            continue
        for it in cat.get("items") or []:
            if set(it.get("clause_ids") or []) & clause_ids:
                hit_titles.append(str(it.get("title") or ""))
    # 每条要求各自归组（组内取最长写法，天然处理「开户许可证」⊃「许可证」这类包含关系），
    # 再按词表序去重——同一组被多条要求命中只插一次图。
    matched = {g for g in (_group_of(t) for t in hit_titles) if g}
    return [kw for kw in CERT_KEYWORDS if kw in matched]


def place_certificates(out: dict[str, str], state: dict) -> dict[str, str]:
    """post-pass 入口（纯函数,返回新 dict,不改动入参）。两道通路，共享同一份 placed 去重：
    ① 锚点定向就位（_place_by_anchor）：营业执照进「营业执照」小节、身份证进授权书的
       「附：…扫描件」行下——每个条目全局只放第一处；
    ② 条款交集章尾追加（原有通路）：招标要求命中词表 × 章 clause_ids 交集 × 库存，
       库有见下图、库无待补充；①已放过的条目这里不再重复。
    定位不到章或词表不命中 → 该章原样不动（附录天然兜底——appendix 只收没去处的，
    见 credentials_chapter.append_credentials_chapter）。sys-creds 结构性排除，双重兜底
    （id 与 system 标记，与 content_pipeline.py 净化系统章同一手法）——绝不触碰。"""
    outline = state.get("outline") or {}
    chapters = {c.get("id"): c for c in outline.get("chapters") or []
                if c.get("id") and not c.get("system") and c.get("id") != SYS_CREDS_ID}
    read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
    credentials = (state.get("run_input") or {}).get("credentials") or []

    result = dict(out)
    # 章序 = 提纲序：定向就位「第一处」的判定要按读者翻阅顺序，不能按 dict 插入序
    ordered = [c.get("id") for c in outline.get("chapters") or []
               if c.get("id") in chapters and c.get("id") in result]
    placed: set[int] = set()
    _place_by_anchor(result, ordered, credentials, placed)
    for cid in ordered:
        html = result.get(cid)
        ch = chapters.get(cid)
        if ch is None or not html:
            continue
        keywords = _matched_keywords(read, _collect_clause_ids(ch.get("items")))
        if not keywords:
            continue
        blocks = []
        for kw in keywords:
            aliases = _aliases_of(kw)
            entry = next((c for c in credentials
                          if any(a in str(c.get("title") or "") for a in aliases)), None)
            if entry is not None and id(entry) in placed:
                continue   # 锚点已就位的材料不再章尾重复一份
            blocks.append(_cert_block(kw, entry))
        if blocks:
            result[cid] = html + "\n" + "\n".join(blocks)
    return result
