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
from agent.agents.bidding_agent.nodes.form_locate import _looks_like_form_title

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
    ("授权书", "授权书", "授权委托书", "法定代表人授权书"),
    ("厂家授权", "厂家授权", "原厂授权", "制造商授权", "厂商授权"),
    ("法定代表人身份证明", "法定代表人身份证明", "法定代表人身份证", "法人身份证明",
     "法人身份证", "法人代表身份证", "法定代表人证明书"),
    ("被授权人身份证明", "被授权人身份证明", "被授权人身份证", "全权代表身份证",
     "委托代理人身份证", "授权代表身份证", "全权代表人和法定代表人身份证"),
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
    ("信用中国截图", "信用中国", "信用记录截图", "信用查询截图"),
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
# 词表里**由投标人撰写**（而非附扫描件）的组——「章即此文书」的待补充抑制只对它们生效。
# 其余组（各类证明/执照/报告/截图）都是要附的材料，章名恰好同名也照常提醒缺货。
_WRITABLE_GROUPS = ("授权书",)
# `_image_alt`（标题|ocrText 截前 120 字）现收在 credentials_chapter.py：附录章占位图 alt
# 与本文件的章内插图 alt 是同一套格式（终审 I-4），不再各自持有一份实现。


def _entry_images_html(entry: dict) -> str:
    """条目逐图占位段（三属性同 credentials_chapter.py 的 build_credentials_chapter，
    无 src 无字节）。框位替换时单独用——图顶替框行，不带引导行。"""
    title = str(entry.get("title") or "").strip()
    parts = []
    for img in entry.get("images") or []:
        file_id = _esc(img.get("fileId"))
        key = _esc(img.get("key"))
        alt = _image_alt(title, img.get("ocrText"))
        parts.append(f'<p><img data-file-id="{file_id}" data-object-key="{key}" alt="{alt}" /></p>')
    return "\n".join(parts)


def _cert_block(keyword: str, entry: dict | None) -> str:
    """单个证照词命中后的章尾追加块：库有该词对应条目 → 见下图 + 该条目逐图占位；
    库无 → 待补充提示。"""
    if entry is None:
        return f"<p>（待补充：{_esc(keyword)}）</p>"
    return "\n".join([f"<p>【{_esc(keyword)}】见下图：</p>", _entry_images_html(entry)])


# 证据词：段落锚点必须带其一。「响应函里顺嘴提到营业执照」不是要材料的地方，
# 「附：全权代表人和法定代表人身份证原件扫描件」才是——不带证据词的散文提及一律不挂图。
_EVIDENCE = re.compile(r"扫描件|原件|复印件|证明材料|加盖公章")

# 身份证组的锚定人名词（导出侧 render/docx 复印章锚定与这里的线上就位**共用同一份**——
# 两处各养一份必然漂移）。组内别名剥「身份证(明)/证明书」后缀即人名词；
# 含「和」的合称词有歧义、二字词（「法人」）会被「合法人员」子串误中——都不当锚。
_ID_SUFFIX_RE = re.compile(r"(身份证明?|证明书)$")


def id_person_words(label: str) -> tuple[str, ...]:
    """证照组标准名 → 锚定人名词（「被授权人身份证明」→ 被授权人/全权代表/委托代理人…）；
    非身份证类返回空。"""
    if "身份证" not in label:
        return ()
    for group in CERT_GROUPS:
        if label in group:
            words = {_ID_SUFFIX_RE.sub("", k) for k in group}
            return tuple(w for w in words if len(w) >= 3 and "和" not in w)
    return ()
_ANCHOR = re.compile(r"<(h[3-6]|p)[^>]*>(.*?)</\1>", re.S)
_TAG = re.compile(r"<[^>]+>")
_TABLE_TOKEN = re.compile(r"<table\b|</table\s*>", re.I)


def _table_spans(html: str) -> list[tuple[int, int]]:
    """最外层 <table>…</table> 的区间。**按开闭计数配平**，不能用非贪婪正则——
    嵌套表格时非贪婪会停在第一个 </table>，外层表格的后半段被当成表外，
    锚点照样插进 <td>（评审 2026-08-13 CONFIRMED 复现）。未闭合的表格视为一直到结尾。"""
    spans: list[tuple[int, int]] = []
    depth, start = 0, 0
    for m in _TABLE_TOKEN.finditer(html or ""):
        if not m.group(0).startswith("</"):
            if depth == 0:
                start = m.start()
            depth += 1
        elif depth:
            depth -= 1
            if depth == 0:
                spans.append((start, m.end()))
    if depth:
        spans.append((start, len(html)))
    return spans


def _anchor_end(html: str, aliases: tuple[str, ...], headings_only: bool = False) -> int:
    """章 HTML 里第一处能挂靠该证照的位置（锚元素闭合处的偏移）：
    小节标题（h3-h6）内文含组内任一写法即算（「一、营业执照副本扫描件」）；
    普通段落还须同时含证据词（授权书表单的「附：…身份证原件扫描件」）。找不到 -1。
    表格内的提及一律不算锚（评审表/资格要求表里满是「提供营业执照扫描件」）：
    插进 <td> 的占位图渲染层会整个丢掉（_emit_table 只取文字），而 html 里已出现
    data-file-id 又会让附录把它滤掉——材料在正文和附录**两头消失**。
    锚点/表格区间对每个（章×条目）都重扫一遍——量级实算约几百次对章级 HTML 的正则
    扫描、总耗时秒级，发生在一次跑几分钟的 content 收尾；预计算+插入后失效管理换
    这点收益不值（评审 2026-08-13 效率项，明确不做）。"""
    tables = _table_spans(html or "")
    for m in _ANCHOR.finditer(html or ""):
        if any(s <= m.start() < e for s, e in tables):
            continue
        text = _TAG.sub("", m.group(2))
        if any(a in text for a in aliases):
            if m.group(1) != "p":
                return m.end()                    # 标题锚（材料小节）
            if not headings_only and _EVIDENCE.search(text):
                return m.end()                    # 段落锚（仅在允许段落的那一轮）
    return -1


def _box_anchor_span(html: str, group: str) -> tuple[int, int] | None:
    """身份证组的**粘贴框替换区间**（2026-08-14 用户终验口径：收图的框说明文字不要了，
    图直接顶替——与导出侧"清空框内文字再放图"同语义）：第一个命中的框行（人名词＋
    「身份证」＋「粘贴」同段，表外 p）整行替换；**拆行形态**（法代框被解析层拆成
    「…复印件或扫描件」/「粘贴处」两行）连粘贴行（≤12 字，防长段顺嘴带「粘贴」被
    冒认）一起替换。取**第一处**＝本人第一个空框；第二个框的说明行留给反面。
    此前身份证只能靠别名子串锚：「附：…身份证原件扫描件」抢走被授权人的证，
    法代证被别章小节标题全局抢注。非身份证组返回 None，照走原有标题/段落锚。"""
    words = id_person_words(group)
    if not words:
        return None
    tables = _table_spans(html or "")
    blocks = [(m.start(), m.end(), _TAG.sub("", m.group(2)))
              for m in _ANCHOR.finditer(html or "")
              if not any(s <= m.start() < e for s, e in tables)]
    for i, (start, end, text) in enumerate(blocks):
        if "身份证" not in text or not any(w in text for w in words):
            continue
        if "粘贴" in text:
            return (start, end)
        if i + 1 < len(blocks) and "粘贴" in blocks[i + 1][2] and len(blocks[i + 1][2]) <= 12:
            return (start, blocks[i + 1][1])
    return None


def _place_by_anchor(result: dict[str, str], ordered_cids: list[str],
                     credentials: list[dict], placed: set[int]) -> None:
    """定向就位（2026-08-12 云上江西用户反馈）：营业执照图要在「营业执照副本扫描件」
    小节底下、法人身份证要在授权书「附：…身份证原件扫描件」那行底下——不是全堆附录。
    按章序扫锚点，每个条目全局只放**第一处**：五个章都提营业执照时只进最先对口的那章，
    重复插图既撑大文件也让评委翻到哪都是同一张执照。placed 由调用方共享，
    章尾追加与附录构建据此去重。原地更新 result。

    **标题锚全局优先**（2026-08-14 生产实测）：响应函正文一句「所附营业执照…均为原件
    扫描件」的承诺套话在章序上先命中，抢走了资格文件章「一、营业执照」的标题级小节——
    执照插进响应函、材料小节只剩指路条。第一轮只认标题锚（真正的材料小节），
    全书都没有标题锚的条目第二轮才允许段落锚。
    **粘贴框锚在两轮之前**（2026-08-14 dc4cdc34 轮）：身份证的「XX的…身份证明…粘贴处」
    框行是比任何小节标题都强的定位——不先跑框锚，法代证被资格文件章的小节标题全局
    抢注、被授权人证错落在「附：…」行后。
    **需求分级**（2026-08-14 用户口径「需要的地方就插入」）：框锚与标题锚是**真需求**，
    各插一份——纸质标书本就把同一张身份证复印进授权书框和资格文件小节两处，全局只放
    一次会让另一处空着；段落锚只是兜底，前两类锚任一放过就不再插。同一章内不重复
    （按 fileId 查重），同类锚全局仍只取第一处。"""
    done: dict[str, set[int]] = {"box": set(), "heading": set(), "para": set()}
    for cid in ordered_cids:                       # ①框轮：图**替换**本人第一个空框的说明行
        html = result.get(cid)
        if not html:
            continue
        for entry in credentials:
            if id(entry) in done["box"] or not entry.get("images"):
                continue
            group = _group_of(str(entry.get("title") or ""))
            if group is None:
                continue
            span = _box_anchor_span(html, group)
            if span is None:
                continue
            html = html[:span[0]] + _entry_images_html(entry) + html[span[1]:]
            done["box"].add(id(entry))
            placed.add(id(entry))
        result[cid] = html
    rounds = (
        ("heading", lambda h, g: _anchor_end(h, _aliases_of(g), True)),   # ②标题锚（材料小节）
        ("para", lambda h, g: _anchor_end(h, _aliases_of(g), False)),     # ③段落锚（兜底）
    )
    for kind, locate in rounds:
        for cid in ordered_cids:
            html = result.get(cid)
            if not html:
                continue
            for entry in credentials:
                if id(entry) in done[kind] or not entry.get("images"):
                    continue
                if kind == "para" and id(entry) in placed:
                    continue                      # 兜底轮：强锚放过的不再插
                group = _group_of(str(entry.get("title") or ""))
                if group is None:
                    continue
                fid = str((entry["images"][0] or {}).get("fileId") or "")
                if fid and f'data-file-id="{fid}"' in html:
                    continue                      # 同一章不放第二份（跨轮查重）
                pos = locate(html, group)
                if pos < 0:
                    continue
                html = html[:pos] + "\n" + _cert_block(group, entry) + html[pos:]
                done[kind].add(id(entry))
                placed.add(id(entry))
            result[cid] = html


# 材料小节 = 标题点名了词表里某个证照组的小节，内容**只能是材料本身**（图），不存在
# "写出来"的正文。原先还要求标题带 截图/扫描件/复印件/证明材料 字样——
# 「一、营业执照及主体资格证明文件」一个都不带，模型照样在执照图下面编了整段
# 声明+材料清单表格（2026-08-13 用户实测：有图就够了，文本一律不要）。
# 全部标题层级都要进边界表——只认 h3-h6 的话，材料小节后面跟着 <h2>（渲染层明确防御过的
# 模型跑偏产物）时切割端点会一路滑到章尾，h2 连同其后所有无关正文被静默删光
# （评审 2026-08-13 CONFIRMED 复现）。h1/h2 只当**边界**，不当材料小节候选。
_HX = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1>", re.S)
_MATERIAL_MIN_LEVEL = 3
# 材料节保留内容：带占位图的段落，和「【XX】见下图：」引导行
_P_BLOCK = re.compile(r"<p[^>]*>.*?</p>", re.S)
_SEE_IMG_LINE = re.compile(r"^【[^】]{1,24}】见下图：?$")


def _strip_section_no(text: str) -> str:
    """「六、信用中国截图」→「信用中国截图」：待补充提示里不带小节编号。"""
    return re.sub(r"^[（(]?[一二三四五六七八九十\d]+[）)、.．\s]*", "", text).strip()


def _in_stock(credentials: list[dict], group: str) -> bool:
    """库里有没有**带图**的该组材料。只看标题不看图会把「建了条目还没传扫描件」当成有货：
    锚点插不出图（无图可插）、清空通路又不清（以为有货），模型编的正文原样交付——
    两头都不管，正是这条通路要堵的洞（评审 2026-08-13 CONFIRMED 复现）。"""
    aliases = _aliases_of(group)
    return any((c.get("images") or []) and any(a in str(c.get("title") or "") for a in aliases)
               for c in credentials)


def _material_body(span: str, label: str, group: str, stocked: bool) -> str:
    """材料节正文的三态（2026-08-13 用户口径：贴了图就够了，不需要文本内容）：
    · 节内有图（锚点已就位/用户手插）→ 只留「见下图」引导行与带图段落，模型编的
      声明/材料清单表格全部删掉；
    · 无图但该组材料已在**别的章**就位（全局只放第一处）→ 一行去向说明，不误导成缺货；
    · 无图也无货 → 一行待补充。"""
    if "<img" in span:
        keep = [b for b in _P_BLOCK.findall(span)
                if "<img" in b or _SEE_IMG_LINE.match(_TAG.sub("", b).strip())]
        return "\n" + "\n".join(keep) + "\n"
    if stocked:
        return f"\n<p>（{_esc(label)}扫描件已插入本文件前文对应章节。）</p>\n"
    return f"\n<p>（待补充：{_esc(label)}）</p>\n"


def _replace_missing_materials(result: dict[str, str], ordered_cids: list[str],
                               credentials: list[dict], noted: set[tuple[str, str]]) -> None:
    """材料小节（标题点名已知证照组）的正文由代码接管，见 _material_body 三态。

    模型编不出材料本身，只能编一段像模像样的描述、甚至替投标人作保证（「经查，我方
    不存在被暂停或取消投标资格…」——2026-08-13 云上江西实测）；有图时它也会在图下面
    补一整段声明+材料清单表格（同日用户实测：多余内容，图就是全部）。提示词拦不住
    这种脑补，删除由代码保证。组外材料判不了库存，不乱动。
    noted 记录 (章id, 组名)，章尾追加通路据此不再重复一条待补充。原地更新 result。"""
    for cid in ordered_cids:
        html = result.get(cid)
        if not html:
            continue
        heads = list(_HX.finditer(html))
        cuts: list[tuple[int, int, str]] = []
        for i, m in enumerate(heads):
            if int(m.group(1)) < _MATERIAL_MIN_LEVEL:
                continue   # h1/h2 只当切割边界，不当材料小节
            if cuts and m.start() < cuts[-1][1]:
                # 已落在上一刀的清除范围里（材料小节嵌套：h3 财务报表下挂 h4 资产负债表）：
                # 再切一刀会与父刀重叠，重组时父刀吞掉子标题、子刀的待补充成了无头孤行
                # （评审 2026-08-13 CONFIRMED 复现）。父级一刀已覆盖整节。
                continue
            text = _TAG.sub("", m.group(2))
            group = _group_of(text)
            # 要写的文书（授权书）不是材料节：它的小节正文就是表单本身，三态接管会把
            # 表单正文当"模型编的说明"删光，只剩一张签署扫描件
            if group is None or group in _WRITABLE_GROUPS:
                continue
            end = next((n.start() for n in heads[i + 1:] if int(n.group(1)) <= int(m.group(1))), len(html))
            span = html[m.end():end]
            body = _material_body(span, _strip_section_no(text), group, _in_stock(credentials, group))
            cuts.append((m.end(), end, body))
            if "<img" not in span and not _in_stock(credentials, group):
                noted.add((cid, group))
        if cuts:
            parts, last = [], 0
            for start, end, rep in cuts:
                parts += [html[last:start], rep]
                last = end
            result[cid] = "".join(parts) + html[last:]


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


def place_certificates(out: dict[str, str], state: dict,
                       protected: frozenset[str] = frozenset()) -> dict[str, str]:
    """post-pass 入口（纯函数,返回新 dict,不改动入参）。三道通路，共享去重：
    ① 锚点定向就位（_place_by_anchor）：营业执照进「营业执照」小节、身份证进授权书的
       「附：…扫描件」行下——每个条目全局只放第一处；
    ② 材料小节清空（_replace_missing_materials）：库无货的材料小节正文换成一行待补充——
       模型编的"像模像样的描述"整节删掉（2026-08-13 用户口径）。protected（表单模板章，
       内容是招标原文逐字保真）绝不参与此通路，删它们的文字等于破坏保真；
    ③ 条款交集章尾追加（原有通路）：招标要求命中词表 × 章 clause_ids 交集 × 库存，
       库有见下图、库无待补充；①已放过的条目、②已留过待补充的组不再重复。
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
    noted: set[tuple[str, str]] = set()
    _place_by_anchor(result, ordered, credentials, placed)
    _replace_missing_materials(result, [c for c in ordered if c not in protected], credentials, noted)
    for cid in ordered:
        html = result.get(cid)
        ch = chapters.get(cid)
        if ch is None or not html:
            continue
        keywords = _matched_keywords(read, _collect_clause_ids(ch.get("items")))
        if not keywords:
            continue
        title = str(ch.get("title") or "")
        # 章本身就是这份**要写的文书**（「法定代表人授权书」章）时，同组的「待补充」不再留：
        # 在授权书章尾写「（待补充：授权书）」等于说"这一章还没写"——审查照抄出一条
        # 高风险、用户看着莫名其妙（2026-08-13 云上江西实测+审查双双反馈）。三条边界
        # （同日评审 CONFIRMED×2 收窄）：
        # · 只限 _WRITABLE_GROUPS：词表里绝大多数组是**要附的材料**（社保证明/纳税证明/
        #   银行资信证明…章名以证明收尾同样构词法命中表单），它们缺货必须照常提醒；
        # · 只吞「待补充」不吞有货：库里有签好的授权书扫描件时，插进本章正是评委要看的；
        # · 厂家授权已拆出独立组，不再与法定代表人授权书同组互吞。
        own_group = _group_of(title) if _looks_like_form_title(title) else None
        blocks = []
        for kw in keywords:
            if (cid, kw) in noted:
                continue   # 材料小节里已留了待补充，章尾不再重复一条
            aliases = _aliases_of(kw)
            # 只认**带图**的条目：标题建了、扫描件没传的条目当没有——否则打出「见下图」
            # 底下却一张图都没有（与 _in_stock 同一类幻影库存，评审 2026-08-13 扫同类）
            entry = next((c for c in credentials
                          if (c.get("images") or []) and any(a in str(c.get("title") or "") for a in aliases)), None)
            if entry is None and kw == own_group and kw in _WRITABLE_GROUPS:
                continue   # 本章即此文书，没货不算缺——正文就是它本身
            if entry is not None and id(entry) in placed:
                continue   # 锚点已就位的材料不再章尾重复一份
            blocks.append(_cert_block(kw, entry))
        if blocks:
            result[cid] = html + "\n" + "\n".join(blocks)
    return result
