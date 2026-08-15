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
from typing import NamedTuple

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
# 中文括号序号行：「（一）报价函」「（2）授权书」——潍坊式磋商文件的格式章用这种编法，
# 只认阿拉伯编号会把真表单边界整个漏掉（2026-08-13 潍坊回放实证）。
_CN_NUM_LINE = re.compile(r"^[（(]([0-9一二三四五六七八九十]{1,3})[）)]\s*(\S.*)$")
_CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
# 弹头符开头的短行是**清单项**不是表单抬头：磋商须知里的响应文件构成清单
# 「◆报价函」「◆报价一览表」逐行列出全部表单名，当边界会把索引指向须知而不是表单
# （2026-08-13 潍坊回放实证）。
_BULLETS = "◆■□●○•·※▲△★☆"


def _cn_val(s: str) -> int:
    """「一」→1、「十二」→12、「3」→3；解析不了返回 0（会被编号链拒掉，安全方向）。"""
    if s.isdigit():
        return int(s)
    if len(s) == 1:
        return _CN_DIGITS.get(s, 0)
    if s.startswith("十"):
        return 10 + _CN_DIGITS.get(s[1:], 0)
    if s.endswith("十") and len(s) == 2:
        return _CN_DIGITS.get(s[0], 0) * 10
    if "十" in s and len(s) == 3:
        return _CN_DIGITS.get(s[0], 0) * 10 + _CN_DIGITS.get(s[2], 0)
    return 0
# 名字里出现句读/填空线即判为散句：「8.如确定我方成交：」「1.具有独立承担民事责任的能力；」
# 「1、根据已收到的项目编号____的采购项目」都是表单**里面**的编号条款（云上江西 sec-2、
# 潍坊报价函正文实测），拿它们当边界会把表单从中间切死。
_PROSE_PUNCT = re.compile(r"[。；;，,：:、？?！!_＿]")
# 表单名长度上限：真实表单名最长的「供应商资格信用承诺函」也才 10 字；「根据已收到的
# 项目编号…的采购项目」这类正文短句动辄十几字，上限放宽一分误报就多一分。
_MAX_NAME = 12
_MAX_HEAD_NO = 30  # 首段编号大于它的多半是年份/金额（「2026年 06月17日」）
_MAX_FORM_CHARS = 12000  # 单份表单的体量上限：超过它说明切出来的根本不是一份表单


def _boundary_of(line: str) -> tuple[int, str, bool, tuple[int, ...] | None] | None:
    """一行是不是表单边界候选 → (层级, 表单名, 本行是否属于表单原文, 编号元组)。
    制表符行是表格内容，直接排除。「1.响应函」的编号行是招标格式章的目录性文字，不进段；
    「报价函」这种裸表单名行本身就是表单的标题（招标原文），必须进段——丢了它，
    保真校验的固定片段就少一行，零模型退路渲染出的表单也没了抬头。
    注意这里只做**词法**判定；非构词法命中的编号行还要过 _segments_of 的编号链语义门。"""
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
            num = tuple(int(x) for x in m.group(1).split("-"))
            return len(num), name, False, num
        return None
    m = _CN_NUM_LINE.match(s)
    if m:
        name = m.group(2).strip()
        val = _cn_val(m.group(1))
        if 0 < val <= _MAX_HEAD_NO and 2 <= len(name) <= _MAX_NAME and not _PROSE_PUNCT.search(name):
            return 1, name, False, (val,)
        return None
    # 无编号行只收构词法命中的短行，且不许带弹头符/括注/句读——「◆报价函」是清单项、
    # 「付款方式」「供应商名称」是栏目行，都不是表单抬头，放进来会把索引指错地方
    if (len(s) <= _MAX_NAME and s[0] not in _BULLETS and _looks_like_form_title(s)
            and not _PROSE_PUNCT.search(s) and "（" not in s and "(" not in s):
        return 1, s, True, None
    return None


def _chains(recent: tuple[int, ...] | None, num: tuple[int, ...]) -> bool:
    """编号是否紧接最近一个已认定的编号边界：同层递增（4-1 → 4-2、4 → 5）或
    父编号后的第一个子编号（4 → 4-1）。

    这道门只拦**非构词法命中**的编号行（「4-2要求的资格文件」这类真边界靠它放行）。
    没有它，表单正文里的短编号行会把表单拦腰切断——「报价函」体内的「3.售后服务承诺」
    编号凭空出现（前面没有 1、2 号边界），被当成边界后表单尾部整段丢失，还被保真机制
    钉死成"这就是全部"（2026-08-13 评审 CONFIRMED 复现）。同理，表单里从 1 重新数起的
    材料清单（「1.营业执照」「2.资质证书」）也因为接不上最近边界的编号而不成为边界。"""
    if recent is None:
        return False
    # 与 recent 的**同深祖先**比较递进：recent=(3,1) 时 (4,) 也是合法续接——只比同深会把
    # 「3-1 之后的 4.xxx」拒掉，那一行就混进明细表的段里成了垃圾固定片段，保真检对着它
    # 必杀所有如实填表的稿（评审 2026-08-13 CONFIRMED）。
    if len(recent) >= len(num):
        anc = recent[:len(num)]
        if num[:-1] == anc[:-1] and num[-1] == anc[-1] + 1:
            return True
    return num[:-1] == recent and num[-1] == 1


def _src_of(item: dict) -> int:
    """条款/标题的来源节点号。**不许写 `or -1`**：0 是合法的首节点号，falsy 短路会把
    文档第一个节点上的表单行丢出区间（评审 2026-08-14 F9）。"""
    src = item.get("src")
    return src if isinstance(src, int) else -1


def _doc_stream(read: dict) -> list[tuple[str, str]]:
    """doc_sections + doc_headings 按文档序展平成 (kind, text) 流；节标题插在本节条款之前。
    kind 只有 "heading"/"clause" 两种——标题必是边界候选，条款要过 _boundary_of。"""
    heading_by_sec = {h.get("sec"): (str(h.get("title") or ""), _src_of(h))
                      for h in (read.get("doc_headings") or [])}
    stream: list[tuple[str, str, int]] = []
    seen: set[str] = set()
    for c in read.get("doc_sections") or []:
        cid = str(c.get("id") or "")
        sec = cid.rsplit("-c", 1)[0] if "-c" in cid else ""
        if sec and sec not in seen:
            seen.add(sec)
            if sec in heading_by_sec:
                title, hsrc = heading_by_sec[sec]
                stream.append(("heading", title, hsrc))
        # 条款文本按行展平：一条条款里可能嵌着多行（表格单元格/紧凑段落），
        # 「报价函」抬头行嵌在多行条款里时整条当一行会漏掉这个边界。
        # src 多行共号（复印机 T2）：旧读标结果没有 src → -1，节点区间自然给 None。
        src = _src_of(c)
        for line in str(c.get("text") or "").splitlines():
            stream.append(("clause", line, src))
    return stream


def _segments_of(stream: list[tuple[str, str]]) -> list[dict]:
    """条款流 → 表单段列表 [{name, depth, lines}]，按出现序。

    边界闭合规则：新边界的层级 ≤ 某开放段的层级 → 那个段结束（「3.报价一览表」的段
    包含「3-1.报价明细表」，到「4.资格文件」才闭合）。节标题一律是边界（层级取其编号，
    无编号取 1）。同名紧邻去重：新边界与上一边界同名（互含）且上一段还没收到内容行 →
    这行是表单自己的标题，作为内容并入上一段，不另起段。"""
    segments: list[dict] = []
    open_segs: list[dict] = []
    recent_num: tuple[int, ...] | None = None   # 最近一个已认定的编号边界（编号链语义门）
    for kind, text, src in stream:
        num: tuple[int, ...] | None = None
        if kind == "heading":
            m = _NUM_LINE.match(_norm(text))
            num = tuple(int(x) for x in m.group(1).split("-")) if m else None
            b = (len(num) if num else 1, text, True, num)
        else:
            b = _boundary_of(text)
        if b is not None and kind == "clause":
            depth, name, own_line, num = b
            # 语义门：非构词法命中的编号行必须接上编号链，否则是表单正文不是边界。
            # 被拒的孤行同时**打断链**——表单里从 1 重新数起的材料清单（1.营业执照
            # 2.资质证书），「1」接不上链被拒后，「2」会恰好接上表单自己的「1.XX函」；
            # 断链让整串清单都进不了边界。失败方向是「宁可不切」，表单保持完整。
            if num is not None and not _looks_like_form_title(name) and not _chains(recent_num, num):
                b, recent_num = None, None
        if b is None:
            for seg in open_segs:
                seg["lines"].append(text)
                seg["srcs"].append(src)
            continue
        depth, name, own_line, num = b
        if num is not None:
            recent_num = num
        last = open_segs[-1] if open_segs else None
        if last is not None and not last["lines"] and (
                _norm(name) in _norm(last["name"]) or _norm(last["name"]) in _norm(name)):
            for seg in open_segs:        # 表单自己的标题行，不是新边界；父段也要这行原文
                seg["lines"].append(text)
                seg["srcs"].append(src)
            continue
        open_segs = [s for s in open_segs if s["depth"] < depth]
        for seg in open_segs:            # 子边界行（「3-1.报价明细表」）是父段（3.）的原文：
            seg["lines"].append(text)    # 丢掉它，一览表与明细表两张表在父段里就连成一张
            seg["srcs"].append(src)
        seg = {"name": name, "depth": depth, "lines": ([text] if own_line else []),
               "srcs": ([src] if own_line else []), "head_src": src}
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


def _match_tier(chapter_core: str, name: str) -> int | None:
    """章名与边界名指同一份表单的**匹配强度**：0=全同、1=互含、2=拆部件命中；不匹配 None。
    复合章名（「承诺函与声明」「法定代表人证明与授权书」）按连接词拆开，任一部件
    （≥3 字，防「声明」两字全中）与边界名互含即算。「报价一览表」≠「供应商情况一览表」
    ——互不包含，部件也对不上。"""
    nc, nb = _norm(chapter_core), _norm(name)
    if len(nc) < _MIN_LOOKUP_NAME or not nb:
        return None
    if nc == nb:
        return 0
    if nc in nb or nb in nc:
        return 1
    if any(len(p) >= _MIN_LOOKUP_NAME and (p in nb or nb in p)
           for p in re.split(r"[与及和、/]", nc)):
        return 2
    return None


def find_form_segment(index: list[dict], chapter_title: str) -> dict | None:
    """按章名从索引里取**单份**表单段；取不到返回 None（调用方走整章兜底/留痕）。

    多个候选先比匹配强度，同强度再按层级取舍，方向随强度而变：
    · 强匹配（全同/互含）取**最浅**——「投标函」章同时命中「1.投标函」和其子项
      「1-1.投标函附录」时必须要父段（父段本就含附录；取子项等于把整份投标函
      交付成一张附录表，2026-08-13 评审 CONFIRMED 复现）；
    · 弱匹配（拆部件）取**最深**——「承诺函与声明」同时命中「4.资格文件及资格
      信用承诺函」（一整章）和「4-1.供应商资格信用承诺函」（那份表单）时要后者。"""
    core = _core_form_name(chapter_title)
    hits = [(t, s) for s in index if (t := _match_tier(core, s["name"])) is not None]
    if not hits:
        return None
    top = min(t for t, _ in hits)
    cands = [s for t, s in hits if t == top]
    if top <= 1:
        return min(cands, key=lambda s: (s["depth"], -len(_norm(s["name"]))))
    return max(cands, key=lambda s: (s["depth"], len(_norm(s["name"]))))


def segment_text(seg: dict | None) -> str:
    """段 → 模板原文；空段/超体量（切出来的根本不是一份表单）都给空串。

    尾部剥掉**编号边界行**（2026-08-14 云上实测：承诺函模板尾巴挂着「4-2要求的资格文件」
    ——局部切片里编号链没建立、邻节标题被当成正文并进段，模型如实不抄它反被判改写）。
    只剥尾部、只剥带编号且非表单构词的行，表单自己的裸抬头一个不动。"""
    if seg is None:
        return ""
    lines = [line for line in seg["lines"] if line.strip()]
    while lines:
        b = _boundary_of(lines[-1].strip())
        if b is not None and b[3] is not None and not _looks_like_form_title(b[1]):
            lines.pop()
            continue
        break
    text = "\n".join(lines)
    return text if 0 < len(text) <= _MAX_FORM_CHARS else ""


def find_form(index: list[dict], chapter_title: str) -> str:
    """find_form_segment 的取文版（slice_single_form 与测试用）。"""
    return segment_text(find_form_segment(index, chapter_title))


def _sub_index(hay: list[str], needle: list[str]) -> int:
    n = len(needle)
    for i in range(len(hay) - n + 1):
        if hay[i:i + n] == needle:
            return i
    return -1


def dedupe_nested(texts: dict[str, str]) -> dict[str, str]:
    """{章id: 模板原文} → 同表，**从父段里摘掉已被别章认领的子块**。

    「3.报价一览表」的段天然包含「3-1.报价明细表」（一览与明细一套，单章场景必须如此）；
    但提纲把明细表也立了章时，两章各拿全套 → 明细表在标书里出现两遍（2026-08-13 云上
    重跑实测）。两个要点（同日评审 CONFIRMED×2 返工）：
    · 在**最终文本**上做，不挑命中路径——struct/条款路切出的父段同样会连带子块；
    · 只**摘除子块本身**（含紧贴其前的编号行），不是裁断到子块起点——裁断会把后面
      没人认领的兄弟表单（「3-2.配件报价表」）一起扔掉，一份招标要求的表单就此消失。"""
    out: dict[str, str] = {}
    items = list(texts.items())
    for cid, text in items:
        lines = text.splitlines()
        for ocid, otext in items:
            other = otext.splitlines()
            if ocid == cid or not other or len(other) > len(lines):
                continue
            idx = _sub_index(lines, other)
            if idx < 0 or (idx == 0 and len(other) == len(lines)):
                continue   # 找不到，或两章文本完全相同（互相摘会双双清空）
            start = idx
            if start and _norm(other[0]) in _norm(lines[start - 1]):
                start -= 1   # 子块的编号行（「3-1.报价明细表」）紧贴其前，一并让给子章
            lines = lines[:start] + lines[idx + len(other):]
        out[cid] = "\n".join(lines)
    return out


def slice_single_form(text: str, chapter_title: str, allow_whole: bool = True) -> str:
    """条款段过「单份闸」：有边界（粗粒度文档一节装好几份）→ 只切出与本章同名的那份；
    切不出 → 空串，调用方当没找到处理——**宁可降级，也不把整节公告当模板下发**。

    「没有任何边界 → 整段就是单份」的直通道只对 allow_whole=True（读标登记的构成项）
    开放：构成项是读标模型明确登记的"这份表单在这里"。章 items 的 clause_ids 是
    **需求条款引用**，指着的常是公告/须知——那些文本恰恰一个表单边界都没有，直通道
    一开，整段须知就成了"报价函模板"（2026-08-13 潍坊回放实证；云上公告同一类）。"""
    stream: list[tuple[str, str, int]] = [("clause", ln, -1) for ln in text.splitlines()]
    segments = _segments_of(stream)
    if not segments:
        return text if allow_whole and 0 < len(text) <= _MAX_FORM_CHARS else ""
    return find_form(segments, chapter_title)


class FormSpan(NamedTuple):
    """表单在招标 docx 里的 body 节点定位（复印机 T2，spec 2026-08-14）。
    start/end=正文内容闭区间（不含边界编号行——「3-1.报价明细表」是目录式编号，
    复印进章会跟我们自己的章标题打架，文本路径的 segment_text 同样排除它）；
    head=边界行自己的节点号（-1=无，如裸抬头已计入内容），去重截断用。"""

    start: int
    end: int
    head: int


def form_node_span(index: list[dict], chapter_title: str) -> FormSpan | None:
    """章名 → FormSpan。旧读标结果没有 src（发版前入库）或段超体量 → None，
    复印机自然回退 HTML 渲染路线。"""
    seg = find_form_segment(index, chapter_title)
    if seg is None or not segment_text(seg):
        return None
    srcs = [s for s in seg.get("srcs") or [] if isinstance(s, int) and s >= 0]
    if not srcs:
        return None
    head = seg.get("head_src", -1)
    return FormSpan(min(srcs), max(srcs), head if isinstance(head, int) else -1)


def dedupe_spans(spans: dict[str, FormSpan]) -> dict[str, FormSpan]:
    """{章id: FormSpan} → 同表，**父区间截到被别章认领的子表单之前**。

    「3.报价一览表」(41-43) 天然含「3-1.报价明细表」(43-43,head=42)：两章各自复印时
    不截父区间，明细表在一览表章里重复一遍。截断点取子段的 head（连它的编号行一起
    从父段摘掉——与文本级 dedupe_nested 同语义）；子段无 head 则截到其内容起点前。"""
    out = dict(spans)
    for a, sp_a in spans.items():
        for b, sp_b in spans.items():
            if a == b:
                continue
            cut = sp_b.head if 0 <= sp_b.head else sp_b.start
            if sp_a.start < cut <= sp_a.end:
                out[a] = out[a]._replace(end=min(out[a].end, cut - 1))
    return out


# 提纲 item 标签打头的序号（「二、」「1.」「（一）」），拆章判定前先剥。
# 裸数字后的分隔符**必须有**（评审 2026-08-15 F2 CONFIRMED：可选分隔符会把
# 「一次性告知承诺书」剥成「次性告知承诺书」，拆出的章标题缺首字印进标书）；
# 括注形（（一））自带边界，后随分隔符可无。
_ORD_PREFIX = re.compile(r"^\s*(?:(?:[0-9]{1,3}|[一二三四五六七八九十]{1,3})\s*[.、．)）]|[（(](?:[0-9]{1,3}|[一二三四五六七八九十]{1,3})[）)])\s*")


def folded_form_items(chapters: list[dict], index: list[dict]) -> dict[str, list[tuple[dict, str]]]:
    """被折进别章的独立表单 item：{章id: [(item, 表单核心名)]}（2026-08-15 fd5a6ced 实测：
    模型把「法定代表人授权书」折进响应函章当小节——零模型路径按章名只取一份模板，
    折叠小节整体蒸发，菜单有、正文无）。①提纲拆章与②零模型守约闸共用本判定。

    一个顶级 item 判为折叠表单须同时满足：
    · 核心名（剥序号）与全文表单索引某段**强匹配**（全同/互含；拆部件的弱匹配不算，
      「资格文件」章不能因带「资格」二字被拆）；
    · 该段不是本章自己对应的段（「响应函正文」是本章正文的小节，不是折叠）；
    · 该段没有任何一章以它为章名（有独立章时 item 只是交叉引用，拆了就是重复章）。"""
    owns = [find_form_segment(index, str(ch.get("title") or "")) for ch in chapters]
    claimed = {id(s) for s in owns if s is not None}
    out: dict[str, list[tuple[dict, str]]] = {}
    for ch, own in zip(chapters, owns):
        ch_core = _core_form_name(str(ch.get("title") or ""))
        for it in ch.get("items") or []:
            if not isinstance(it, dict):
                continue
            core = _core_form_name(_ORD_PREFIX.sub("", str(it.get("label") or "")))
            if len(_norm(core)) < _MIN_LOOKUP_NAME:
                continue
            if _match_tier(ch_core, core) is not None:
                continue                     # 本章自己那份表单的组成部分
            seg = find_form_segment(index, core)
            if seg is None or seg is own or id(seg) in claimed:
                continue
            tier = _match_tier(core, seg["name"])
            if tier is None or tier > 1:     # 0 是合法的「全同」，不能用 or 兜底（同 _src_of 教训）
                continue                     # 只认全同/互含的强匹配
            claimed.add(id(seg))             # 同一份表单最多拆一次
            out.setdefault(str(ch.get("id") or ""), []).append((it, core))
    return out
