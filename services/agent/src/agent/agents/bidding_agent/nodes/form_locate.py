"""表单模板的全文定位：把招标文件切成「一份表单一段」，按章名取单份。

为什么不能按解析出的节（sec）拿模板（2026-08-12 云上江西实测，废标级事故）：
.doc 里「1.响应函」「2.法定代表人授权书」这些行没做成 Word 标题样式，整份文件只切出
九个节——整份采购公告挤在一个节里、全部表单挤在另一个节里。按「条款所在节整节取」，
响应函章拿到的"模板"是**整份采购公告**，授权书章拿到的是**三份表单连体**，保真机制
再把这份错误模板逐字钉死——每个表单章都成了公告转储，一份能用的表单都没有。

这里改成对**全文条款流**（含节标题，按文档序展平）识别表单边界，边界之间就是一份表单：
  · 编号短行：「1.响应函」「3-1.报价明细表」「4-2要求的资格文件」（点号可省）
  · 节标题：解析器认出的标题本来就是边界（潍坊式文档每份表单一节，靠这条覆盖）
  · 无编号构词法行：「供应商情况一览表」这类没编号、独占一行的表单名
子编号归并（「3.报价一览表」的段包含「3-1.报价明细表」——一览表与明细表本就是一套），
同名紧邻去重（「2.法定代表人授权书」下一行常跟同名标题行，那是表单自己的标题，
不去重会把表单被自己的标题切死成空段）。

「1.响应函」常挂在**上一节的末尾**（切分器在样式标题处另起节，编号行留在前一节）——
所以必须全文流切，按节切必漏。
"""
from __future__ import annotations

import re

# 表单类章节的识别：**按构词法判，不靠穷举**。平表穷举栽过——「报价函」不在表里，
# 整章拿不到招标格式原文，模型只能自己编（2026-08-11 潍坊实测：招标 7 条固定条款 →
# 生成 6 条全新措辞）。判据分两层（详见各自注释），原先住在 content.py，
# 全文定位也要用同一份判据，搬到这里由 content.py 反向引用——两处各写一份就会长歪。
#
# ① 构词短语（标题里出现即算）——「X表」「X书」里的 X 才是决定性的那半个词。
#    只看后缀「表」「书」会把「技术偏离表」「技术标书」全判成表单（2026-08-12 评审实证）。
#    短语要**整词命中**，所以不放裸「授权」「委托」——会误伤「授权服务体系」。
# ② 尾字（去编号括注后收尾）——「函」「证明」收尾的几乎必是表单文书。
#    「书」「表」「声明」不放这里，理由同上；它们靠 ① 的整词短语命中。
_FORM_WORDS = ("格式", "一览表", "报价表", "简历表", "汇总表", "明细表", "申报表", "申请表",
               "承诺书", "委托书", "授权书", "保证书", "确认书",
               "投标函", "响应函", "报价函", "承诺函", "声明函", "身份证明", "声明")
_FORM_SUFFIXES = ("函", "证明")
_MIN_LOOKUP_NAME = 3   # 按名字检索的最短表单名：「证明」「声明」两个字全文到处都是


def _core_form_name(title: str) -> str:
    """章标题 → 表单本名（去章节编号与括注）：「第一章 报价函（商务标）」→「报价函」。
    判定与检索共用同一份清洗——两处各写一遍就会慢慢长歪。"""
    core = re.sub(r"[（(].*?[）)]", "", title).strip()           # 去括注
    core = re.sub(r"^[第一二三四五六七八九十\d]+[章节、.\s]+", "", core).strip()   # 去章节编号
    return re.sub(r"[（(].*$", "", core).strip()                 # 去未闭合的括注残尾

def _looks_like_form_title(title: str) -> bool:
    """标题像不像表单：命中构词短语，或去掉编号/括注后以表单尾字收尾。"""
    return any(w in title for w in _FORM_WORDS) or _core_form_name(title).endswith(_FORM_SUFFIXES)


def _norm(text: str) -> str:
    """比对用归一化：去掉所有空白（含全角空格）。「响   应   函」要能等于「响应函」。"""
    return re.sub(r"[\s　]+", "", text or "")


# 编号行：「1.响应函」「3-1.报价明细表」「4-2要求的资格文件」（点号/顿号可省）。
_NUM_LINE = re.compile(r"^(\d+(?:-\d+)*)\s*[.、．]?\s*(\S.*)$")
# 名字里出现句读/填空线即判为散句：「8.如确定我方成交：」「1.具有独立承担民事责任的能力；」
# 「1、根据已收到的项目编号____的采购项目」都是表单**里面**的编号条款（云上江西 sec-2、
# 潍坊报价函正文实测），拿它们当边界会把表单从中间切死。
_PROSE_PUNCT = re.compile(r"[。；;，,：:、？?！!_＿]")
# 表单名长度上限：真实表单名最长的「供应商资格信用承诺函」也才 10 字；「根据已收到的
# 项目编号…的采购项目」这类正文短句动辄十几字，上限放宽一分误报就多一分。
_MAX_NAME = 12
_MAX_HEAD_NO = 30  # 首段编号大于它的多半是年份/金额（「2026年 06月17日」）
_MAX_FORM_CHARS = 12000  # 单份表单的体量上限：超过它说明切出来的根本不是一份表单


def _boundary_of(line: str) -> tuple[int, str, bool] | None:
    """一行是不是表单边界 → (层级, 表单名, 本行是否属于表单原文)。制表符行是表格内容，直接排除。
    「1.响应函」的编号行是招标格式章的目录性文字，不进段；「报价函」这种裸表单名行
    本身就是表单的标题（招标原文），必须进段——丢了它，保真校验的固定片段就少一行，
    零模型退路渲染出的表单也没了抬头。"""
    if "\t" in line:
        return None
    s = line.strip()
    if not s or len(s) > _MAX_NAME + 8:
        return None
    m = _NUM_LINE.match(s)
    if m:
        name = m.group(2).strip()
        if (int(m.group(1).split("-")[0]) <= _MAX_HEAD_NO
                and 2 <= len(name) <= _MAX_NAME and not _PROSE_PUNCT.search(name)):
            return m.group(1).count("-") + 1, name, False
        return None
    # 无编号行只收构词法命中的短行，且不许带任何括注/句读——「付款方式」「供应商名称」
    # 这类栏目行不是表单名，放进来会把表单切碎
    if len(s) <= _MAX_NAME and _looks_like_form_title(s) and not _PROSE_PUNCT.search(s) and "（" not in s and "(" not in s:
        return 1, s, True
    return None


def _doc_stream(read: dict) -> list[tuple[str, str]]:
    """doc_sections + doc_headings 按文档序展平成 (kind, text) 流；节标题插在本节条款之前。
    kind 只有 "heading"/"clause" 两种——标题必是边界候选，条款要过 _boundary_of。"""
    heading_by_sec = {h.get("sec"): str(h.get("title") or "")
                      for h in (read.get("doc_headings") or [])}
    stream: list[tuple[str, str]] = []
    seen: set[str] = set()
    for c in read.get("doc_sections") or []:
        cid = str(c.get("id") or "")
        sec = cid.rsplit("-c", 1)[0] if "-c" in cid else ""
        if sec and sec not in seen:
            seen.add(sec)
            if sec in heading_by_sec:
                stream.append(("heading", heading_by_sec[sec]))
        stream.append(("clause", str(c.get("text") or "")))
    return stream


def _segments_of(stream: list[tuple[str, str]]) -> list[dict]:
    """条款流 → 表单段列表 [{name, depth, lines}]，按出现序。

    边界闭合规则：新边界的层级 ≤ 某开放段的层级 → 那个段结束（「3.报价一览表」的段
    包含「3-1.报价明细表」，到「4.资格文件」才闭合）。节标题一律是边界（层级取其编号，
    无编号取 1）。同名紧邻去重：新边界与上一边界同名（互含）且上一段还没收到内容行 →
    这行是表单自己的标题，作为内容并入上一段，不另起段。"""
    segments: list[dict] = []
    open_segs: list[dict] = []
    for kind, text in stream:
        if kind == "heading":
            m = _NUM_LINE.match(_norm(text))
            b = (m.group(1).count("-") + 1 if m else 1, text, True)
        else:
            b = _boundary_of(text)
        if b is None:
            for seg in open_segs:
                seg["lines"].append(text)
            continue
        depth, name, own_line = b
        last = open_segs[-1] if open_segs else None
        if last is not None and not last["lines"] and (
                _norm(name) in _norm(last["name"]) or _norm(last["name"]) in _norm(name)):
            for seg in open_segs:        # 表单自己的标题行，不是新边界；父段也要这行原文
                seg["lines"].append(text)
            continue
        open_segs = [s for s in open_segs if s["depth"] < depth]
        for seg in open_segs:            # 子边界行（「3-1.报价明细表」）是父段（3.）的原文：
            seg["lines"].append(text)    # 丢掉它，一览表与明细表两张表在父段里就连成一张
        seg = {"name": name, "depth": depth, "lines": ([text] if own_line else [])}
        segments.append(seg)
        open_segs.append(seg)
    return segments


def build_form_index(read: dict) -> list[dict]:
    """读标结果 → 全文表单段索引。content 步每个 run 调一次，各章共用。"""
    return _segments_of(_doc_stream(read))


def is_form_title_line(line: str) -> bool:
    """一行是不是表单自己的抬头（「响   应   函」「法定代表人授权书」）。
    渲染层据此把抬头排成**居中标题**——招标表单的抬头都是居中的，排成左对齐正文段落
    等于格式跟招标书对不上（2026-08-13 用户实测反馈）。判定与切割共用同一份边界规则
    （先并掉抬头里的排版空格——「响   应   函」原样匹配不到「响应函」）。"""
    b = _boundary_of(_norm(line))
    return b is not None and b[2]


def _match_name(chapter_core: str, name: str) -> bool:
    """章名与边界名是否指同一份表单。互含直接算；复合章名（「承诺函与声明」
    「法定代表人证明与授权书」）按连接词拆开，任一部件（≥3 字，防「声明」两字全中）
    与边界名互含即算。「报价一览表」≠「供应商情况一览表」——互不包含，部件也对不上。"""
    nc, nb = _norm(chapter_core), _norm(name)
    if len(nc) < _MIN_LOOKUP_NAME or not nb:
        return False
    if nc in nb or nb in nc:
        return True
    return any(len(p) >= _MIN_LOOKUP_NAME and (p in nb or nb in p)
               for p in re.split(r"[与及和、/]", nc))


def find_form(index: list[dict], chapter_title: str) -> str:
    """按章名从索引里取**单份**表单原文；取不到返回空串（调用方走整章兜底/留痕）。
    多个候选取层级最深的（「承诺函与声明」同时命中「4.资格文件及资格信用承诺函」和
    「4-1.供应商资格信用承诺函」时要后者——前者是一整章，后者才是那份表单）。"""
    core = _core_form_name(chapter_title)
    hits = [s for s in index if _match_name(core, s["name"])]
    if not hits:
        return ""
    best = max(hits, key=lambda s: (s["depth"], len(_norm(s["name"]))))
    text = "\n".join(line for line in best["lines"] if line.strip())
    return text if 0 < len(text) <= _MAX_FORM_CHARS else ""


def slice_single_form(text: str, chapter_title: str) -> str:
    """读标登记的条款段过「单份闸」：段里没有任何表单边界 → 它就是单份，原样可用；
    有边界（粗粒度文档一节装好几份）→ 只切出与本章同名的那份；切不出 → 空串，
    调用方当没找到处理——**宁可降级，也不把整节公告当模板下发**。"""
    stream: list[tuple[str, str]] = [("clause", ln) for ln in text.splitlines()]
    segments = _segments_of(stream)
    if not segments:
        return text if 0 < len(text) <= _MAX_FORM_CHARS else ""
    return find_form(segments, chapter_title)
