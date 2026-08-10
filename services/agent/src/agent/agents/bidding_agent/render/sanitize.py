"""章节 HTML 清洗（e2e 实测缺陷）：模型无视"只输出片段"指令，把整章写成完整 HTML 文档
（<!DOCTYPE><html><head><style>body{max-width/margin/padding...}</style>...）。
前端 dangerouslySetInnerHTML 渲染时 <style> 泄漏劫持全页布局（整站被限宽居中"变形"）；
docx 渲染时 head/style 文本会被当正文吐出。收稿与渲染入口统一过此清洗。"""
from __future__ import annotations
import re

from agent.parsing.types import SYSTEM_NOTE_PREFIX

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


_CN_DIGIT = {"零": 0, "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _cn_to_int(s: str) -> int | None:
    """中文数字（1..99）→ 整数：十=10、十二=12、二十一=21。解析不了返回 None。"""
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if "十" in s:
        tens_s, _, units_s = s.partition("十")
        tens = _CN_DIGIT.get(tens_s, None) if tens_s else 1
        units = _CN_DIGIT.get(units_s, None) if units_s else 0
        if tens is None or units is None:
            return None
        return tens * 10 + units
    return _CN_DIGIT.get(s)


_NO_FORMS = re.compile(r"^\s*(?:第\s*([0-9〇零一二三四五六七八九十]{1,3})\s*章|([0-9]{1,2})|([〇零一二三四五六七八九十]{1,3})[、.．])\s*$")


def chapter_ordinal(no: str) -> int | None:
    """章序号文本 → 阿拉伯数（第七章/第7章/7/七、→ 7）。自定义序号（附录A 等）返回 None，
    调用方据此跳过编号改写（宁不动勿改错）。"""
    m = _NO_FORMS.match(no or "")
    if not m:
        return None
    return _cn_to_int(m.group(1) or m.group(2) or m.group(3))


# 首个元素若是 h1/h2 章级标题则剥掉：章标题（章号+章名）由提纲统一渲染，正文内嵌的是
# 生成时旧值——用户改标题/重排编号后导出会"旧章标题又冒出来"（230 生产实测）。
_LEAD_HEADING = re.compile(r"^\s*<h([12])[^>]*>(.*?)</h\1>\s*", re.I | re.S)
_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
# 章级编号形态：第X章 强信号；裸数字（非 N.M）/中文数字顿号 是弱信号（需下级标题佐证）
_STRONG_NO = re.compile(r"^第\s*[0-9〇零一二三四五六七八九十百]{1,3}\s*章")
_WEAK_NO = re.compile(r"^(?:[0-9]{1,2}(?![.．]?[0-9])[、.．\s]|[〇零一二三四五六七八九十]{1,3}[、.．])")
_HIER_PREFIX = re.compile(r"^[0-9]{1,2}[.．][0-9]")   # N.M 开头 = 子项级标题，绝不当章标题剥
_NO_PREFIX = re.compile(r"^(?:第\s*[0-9〇零一二三四五六七八九十百]{1,3}\s*章|[0-9]{1,2}(?![.．]?[0-9])[、.．\s]?|[〇零一二三四五六七八九十]{1,3}[、.．])\s*")
_HEADING_ANY = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1>", re.I | re.S)
# 层级编号前缀（N.M 或 N.M.K…，可被行内标签包住）：首段改写为当前章号
_HIER_NO = re.compile(r"(<h[234][^>]*>\s*(?:<[^>]+>\s*)*)([0-9]{1,2})((?:[.．][0-9]{1,3})+)", re.I)
_BARE_NO_TEXT = re.compile(r"^[0-9]{1,2}[、\s]")      # 裸编号小节（"2 实施"）——存在即整章不改编号
def _id_prefix_re(chapter_id: str) -> "tuple[re.Pattern[str], str] | None":
    r"""提纲内部 id 泄漏进标题（生产实测：导出成「t3.1 升级改造部署实施方案」，目录里全是 t2.3/t3.1）。
    只剥**本章自己的 id**、且其后必须紧跟点分/连字号数字（t3.1 / t3-1 这种"被当编号抄进标题"的形态）。
    早先按 [tb]\d 通配去剥，会把中文标书里极常见的「T3 航站楼」「B1 层车库」吃成「3 航站楼」「1 层车库」——
    还会连锁触发 _BARE_NO_TEXT 让整章编号不再重排、并让章级标题被误删（评审实测三处损伤）。"""
    if not re.fullmatch(r"[a-zA-Z]{1,2}[0-9]{1,3}", chapter_id or ""):
        return None
    digits = re.sub(r"[^0-9]", "", chapter_id)   # t3 → 3：只摘掉字母，编号数字是真编号要留
    return re.compile(rf"(<h[1-6][^>]*>\s*(?:<[^>]+>\s*)*){re.escape(chapter_id)}(?=[.\-][0-9])", re.I), digits


def _drop_leading_chapter_heading(html: str, title: str) -> str:
    """剥正文首个 h1/h2 章级标题。审查修正后的判定（宁留勿删，全部条件缺一不可）：
    ① 不是子项级标题（N.M 开头绝不剥）；② 剩余部分没有同级或更高级标题（有并列小节 =
    它是普通小节标题，不是章级容器）；③ 语义命中之一：去编号前缀后与当前章标题**相等**
    （"包含"会误杀「售后服务体系」这类含章标题词的子项）／「第X章」强编号／弱编号且确有下级标题。"""
    m = _LEAD_HEADING.match(html)
    if not m:
        return html
    level, raw = int(m.group(1)), _TAGS.sub("", m.group(2)).strip()
    rest = html[m.end():]
    if _HIER_PREFIX.match(raw):
        return html
    for hm in _HEADING_ANY.finditer(rest):
        if int(hm.group(1)) <= level:
            return html
    wanted = _WS.sub("", title or "")
    if wanted and _WS.sub("", _NO_PREFIX.sub("", raw)) == wanted:
        return rest
    if _STRONG_NO.match(raw):
        return rest
    if _WEAK_NO.match(raw) and _HEADING_ANY.search(rest):
        return rest
    return html


def _renumber_hier_headings(html: str, n: int) -> str:
    """h2-h4 层级编号（N.M…）首段改写为章号 n。先体检整章编号形态，两类情况一律不动
    （审查修正：盲改会造出 7.1/7.1 重号或父子编号打架）：
    ① 存在裸编号小节标题（"2 实施"式——它不会被改写，改了子级会与它打架）；
    ② 层级编号首段不唯一（1.x 与 2.x 混排 = 多小节体，统一改成 n.x 必重号）。"""
    firsts: set[str] = set()
    for hm in _HEADING_ANY.finditer(html):
        if int(hm.group(1)) not in (2, 3, 4):
            continue
        text = _TAGS.sub("", hm.group(2)).strip()
        hier = re.match(r"^([0-9]{1,2})[.．][0-9]", text)
        if hier:
            firsts.add(hier.group(1))
        elif _BARE_NO_TEXT.match(text):
            return html
    if len(firsts) != 1:
        return html
    return _HIER_NO.sub(lambda m: f"{m.group(1)}{n}{m.group(3)}", html)


def normalize_chapter_html(html: str, no: str, title: str, chapter_id: str = "") -> str:
    """章正文与提纲对齐：剥内嵌旧章级标题 + 小节层级编号首段跟随当前章号。
    确定性、宁留勿删/宁不动勿改错（规范形态下幂等）；no 解析不出数字时编号不动。
    导出渲染与前端编辑器装载共用同一套规则
    （前端 TS 版见 apps/web/lib/chapter-normalize.ts，改语义须两侧同步）。"""
    if not html:
        return html
    # 先摘掉本章 id 前缀，后续编号判定才看得到真编号（chapter_id 缺省则整步跳过，行为与旧版一致）
    id_rule = _id_prefix_re(chapter_id)
    out = id_rule[0].sub(lambda m: m.group(1) + id_rule[1], html) if id_rule else html
    out = _drop_leading_chapter_heading(out, title)
    n = chapter_ordinal(no)
    if n is not None:
        out = _renumber_hier_headings(out, n)
    return out


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


# 内部标识不能出现在给用户看的文字里。2026-08-08 全量扫描线上产物，四处都在漏：
# 审查报告 115 处（「对应：评审办法（sec-2-c8）…」）、正文 3 处（连表格单元格里都写着
# 「sec-37-c36~c37」，等于交给评委的标书上印着我们的内部编号）、述标 1 处、读标 1 处。
# sec-N-cM 是条款 id，required_structure/clause_ids 是读标结果的字段名——用户看只会当成乱码。
# 字段说明里已明写禁止，但那是"请模型配合"；确定性清洗才是能保证的那一半。
# 区间右端两种写法都有：缩写的「sec-37-c36~c37」和写全的「sec-55-c11~sec-55-c20」。
# 只认缩写那种的话，写全的会被当成两个独立 id 分别抹掉，留下「（~）」这个更难看的残骸。
# 左边界 (?<![A-Za-z]) 必须有：没有它「IPsec-3DES」里的「sec-3」会被当成 id 抹掉，
# 变成「IPDES」——这是要交付的技术方案原文，不是我们编的号。
_ID = r"(?<![A-Za-z])sec-\d+(?:-c\d+(?:\s*[~～-]\s*(?:sec-\d+-)?c?\d+)?)?"
_ID_BARE = re.compile(_ID)
_FIELD_NAMES = re.compile(r"\b(?:required_structure|clause_ids|target_id|target_tab|chapter_id)\b")

# 哨兵替换架构：先把每个 id 换成一个正文不可能出现的私用区字符，后面每一步清理都
# 只处理"紧贴着哨兵"的括号/分隔符/空白——清理天生只会碰到"因删 id 而残"的位置，
# 不会误伤本来就存在的顿号/逗号（哪怕它紧挨着 <strong> 这类行内标签）、
# 也不会误删"是（ ）否（ ）"这种从一开始就合法的空括号。
_SENTINEL = ""
_SEP = "、,，;；"
# 整组括号只剩哨兵（含字段名被删后遗留的冒号）→ 连括号一起去掉
_SENTINEL_GROUP = re.compile(rf"[（(]\s*[:：]?\s*{_SENTINEL}(?:\s*[{_SEP}]\s*{_SENTINEL})*\s*[)）]")
# 三个以上编号连写抹成的哨兵串，先并成一个，再交给下面的悬挂规则收尾
_SENTINEL_CHAIN = re.compile(rf"{_SENTINEL}(?:\s*[{_SEP}]\s*{_SENTINEL})+")
# 只清哨兵**右边**紧跟的分隔符（id 消失后，它成了后面内容开头的悬空标点，一定是残渣）。
# 哨兵**左边**的分隔符不能同样清——它常是前一句真实内容自己的收尾标点（「响应；sec-58-c1 …」
# 里的分号是「响应」这句的句读，不是编号列表的胶水，一并抹掉会连用户内容的标点都吃掉）。
_SENTINEL_TAIL_SEP = re.compile(rf"{_SENTINEL}\s*[{_SEP}]")
_SENTINEL_WS = re.compile(rf"\s*{_SENTINEL}\s*")
# 整段只剩一个空壳标签（「<p>对应招标文件条款：。</p>」——内容全是编号，抹完什么都不剩）：
# p/li 连段一起去掉；**td/th 只清空内容、保留 <td></td> 占位**——删掉整个单元格元素
# 会让同一行后面的列全部错位（偏离表这类表格，评委看到的是错位后的判定）。
# 冒号后必须紧跟句末标点才算空壳，「<p>说明：</p>」这类领起下文的标签不受影响。
_EMPTY_SHELL = re.compile(r"<(p|li|td|th)\b[^>]*>\s*[^<>]{0,40}[：:]\s*[。；;]\s*</\1>")


def _empty_shell_repl(m: "re.Match[str]") -> str:
    tag = m.group(1)
    return f"<{tag}></{tag}>" if tag in ("td", "th") else ""


def clean_internal_ids(text: str) -> str:
    """抹掉内部条款 id 与字段名，并收拾抹完留下的括号/标点/空白残迹（哨兵替换架构，见上）。"""
    if not text:
        return text
    out = _ID_BARE.sub(_SENTINEL, text)
    out = _FIELD_NAMES.sub("", out)
    out = _SENTINEL_GROUP.sub("", out)
    out = _SENTINEL_CHAIN.sub(_SENTINEL, out)
    out = _SENTINEL_TAIL_SEP.sub(_SENTINEL, out)
    out = _SENTINEL_WS.sub(_SENTINEL, out)
    out = out.replace(_SENTINEL, "")
    out = re.sub(r"\s{2,}", " ", out)
    out = re.sub(r"(——|—)\s+", r"\1", out)                      # 抹掉字段名后破折号后面留下的空格
    out = re.sub(r"(?:——|—|-{2,})\s*(?=[，。；、]|$)", "", out)   # 「xxx——」后面全空了，破折号也别留
    # 中文标点后不该有空格：述标评分行「sec-54-c1 ★A；sec-58-c1 ★B」抹完会留下「★A； ★B」
    out = re.sub(r"(?<=[，。；、：])[ 　]+", "", out)
    out = _EMPTY_SHELL.sub(_empty_shell_repl, out)
    return out.strip(" 　·、，,")


# 模型把**我们自己**加进送审材料里的辅助信息当成了投标文件的内容。2026-08-11 生产实测（康恒环境）：
# 「[中风险] 投标文件多处出现章节编号(如 sec-xxx)和内嵌图片标记，未作清理，影响文件整洁性和专业性」
# ——用户的 .docx 里没有任何这类东西，是我们拼识别文字时加的注记和自己的章节键。
# 提示词里已明令这些不属于投标文件（见 prompts/review.SYSTEM_NOTE_RULE），但那是"请模型配合"；
# 弱模型上失效过不止一次，确定性识别才是能保证的那一半。
# **硬约束：宁可漏过一条格式抱怨，也绝不许删掉一条真发现。** 判据因此只认两种
# 「真发现里不可能出现」的形态，一律不碰真实条款 id：
#   · 「系统注记」——注记的统一前缀（SYSTEM_NOTE_PREFIX）本身，模型抄了或复述了；
#   · 泛指写法的编号占位符（sec-xxx / sec-N / sec-* / sec-?）——线上那条投诉原文写的正是
#     「如 sec-xxx」。**真 id（sec-2-c8）一个都不算**：模型把真条款 id 写进 tender_ref/advice
#     是提示词点名要求的常态行为（2026-08-08 全量实测审查报告里 115 处），拿它当"抱怨证据"
#     就会把废标级高风险发现整条删掉——那比多报一条格式抱怨严重一个数量级。
#     边界两侧都卡死：左边排除字母/数字/连字符（「IPsec-3DES」「30-sec-timeout」是正文原话），
#     右边要求占位符后面不再接字母数字（否则 sec-next 这类普通英文也会中）。
# re.escape：前缀是"四处共用、以后可能会调"的常量，带元字符时不加转义会在 import 期抛 re.error。
_NOTE_WORD = re.escape(SYSTEM_NOTE_PREFIX.lstrip("【"))
_SYSTEM_NOTE_MENTION = re.compile(
    rf"{_NOTE_WORD}|(?<![A-Za-z0-9-])sec-(?:[xX]+|[nN]|\*+|\?+)(?![A-Za-z0-9])")


def mentions_system_note(*texts: str) -> bool:
    """这几段文字里有没有在谈论系统注记 / 编号占位符（即：模型把我们的辅助信息当成了文件内容）。

    **只该拿"这条发现在说什么"的字段来问**（title / advice），不要拿 tender_ref / chapter_title：
    那两个字段模型本来就被要求写出处与章节名，里面出现编号是它照做，不是它在抱怨。"""
    return any(_SYSTEM_NOTE_MENTION.search(t) for t in texts if t)
