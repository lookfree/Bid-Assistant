from __future__ import annotations

import asyncio
import json
import logging
import re
from html import escape, unescape

from agent.framework.budget import chapter_budget, estimate_tokens
from agent.parsing import storage_read
# 扫描页识别（OCR 未配置时是恒等变换）；deadline 由本模块起一次，跨受审文件共享
from agent.parsing.ocr import needs_ocr
from agent.parsing.ocr import new_deadline as ocr_deadline
from agent.parsing.ocr import ocr_docx_images, ocr_scanned_pages
from agent.parsing.service import read_and_parse
from agent.parsing.storage_read import storage      # spec106 MinIO 单例
from agent.parsing.types import SYSTEM_NOTE_PREFIX  # 送审材料里「这是系统加的说明」的统一前缀
from agent.runtime.progress import publish_phase     # 各节点推阶段事件（read/outline/review/present 共用）

logger = logging.getLogger(__name__)

__all__ = ["publish_phase", "upload_artifact", "fetch_master_bytes", "package_scope",
           "filter_read_by_package", "slim_read", "parse_bid_docs", "parse_bid_chapters",
           "html_to_review_text",
           "allocate_chapter_budget", "chapters_budget", "chapters_in_outline", "compress_read",
           "strip_clause_ids",
           "MIN_CHAPTER_CHARS"]


def _section_titles(parsed, with_body: set[str]) -> dict[str, str]:
    """{节号: 喂给模型的标题}。**父级标题并进它子节的标题**（`1.技术偏离表 / 1.1.2 …偏离表`）。

    父级往往只有标题、正文全在子节里（`1.技术偏离表` → `1.1 总体技术规范偏离表` →
    `1.1.2 核心架构要求偏离表`）,这种节不产章,标题就此丢掉——模型只拿到叶子标题,
    不知道它归属哪一类要求,与"把节名给模型"的目的正好相抵。
    只补**自己不产章**的父级：有正文的父级本来就自成一章,再重复给它一遍只是白花预算。"""
    titles: dict[str, str] = {}
    pending: list[tuple[int, str]] = []          # 还没被任何一章带上的父级标题
    for h in parsed.headings or []:
        level, title = h.get("level") or 0, (h.get("title") or "").strip()
        pending = [(lv, t) for lv, t in pending if lv < level]   # 同级/更深的到此为止
        if h.get("sec") in with_body:
            titles[h["sec"]] = " / ".join([t for _lv, t in pending] + [title]) if title else ""
        elif title:
            pending.append((level, title))
    return titles


def _aggregate(parsed, out: dict[str, str]) -> None:
    """一份解析结果按节聚合进 out（追加成 sec-1..N 的连续键）。**节号全局重排**——
    每份文件的节号都从 sec-1 起,直接合并会让后一份把前一份的同号节整节覆盖（静默丢半本标书）。

    **章节标题随它自己那一节的正文一起进去**（节首一个 <h3>,父级标题见 _section_titles）：
    解析层的口径是「标题另存 headings、不进 clauses」,只吃 clauses 的话模型拿到的是一堆
    没有名字的正文块。docx 认出 Word 大纲层级之后一份文件动辄几百条标题,而「1.1.2 核心架构
    要求偏离表」这种标题正是模型判断这一段在答什么的唯一线索——丢了它,审查就会把文档里
    明明写着的条款报成「未响应」（2026-08-10 用户实例）。headings 本身照常产出,
    供 _clause_source 与前端定位使用。
    只有标题、没有正文的节仍不产章：那种节没有可体检的内容,凭空多出来只会挤掉别的章的额度。

    条款原文与标题**必须转义**再放进标签：标书里"响应时间<30分钟，可用率>99.9%"这类写法在
    技术偏离表、服务承诺表里遍地都是,裸拼的话 "<30分钟，可用率>" 就是一个像模像样的标签,
    下游剥标签时被整段吃掉——模型读到的是"响应时间99.9%",SLA 承诺正好读反。
    喂模型前的还原由消费方各自做（html_to_review_text / present._plain 都会 unescape）。
    quote=False：这里是元素文本不是属性值,引号原样留着更省字数也更贴近原文。"""
    by_sec: dict[str, list[str]] = {}
    for c in parsed.clauses:
        m = re.match(r"^(sec-\d+)-", c.get("id") or "")
        if m:
            by_sec.setdefault(m.group(1), []).append(c.get("text") or "")
    titles = _section_titles(parsed, set(by_sec))
    for sec, texts in by_sec.items():
        html = "".join(f"<p>{escape(t, quote=False)}</p>" for t in texts if t)
        if html:
            title = (titles.get(sec) or "").strip()
            head = f"<h3>{escape(title, quote=False)}</h3>" if title else ""
            out[f"sec-{len(out) + 1}"] = head + html


def _key_list(keys: str | list[str]) -> list[str]:
    """兼容旧调用形状：单个 key 的字符串 = 只有一份文件。"""
    return [keys] if isinstance(keys, str) else keys


async def parse_bid_docs(keys: str | list[str], ctx=None) -> tuple[dict[str, str], list[dict]]:
    """线下标书 → (chapters, 还看不见的扫描页统计)（spec328 独立审查 / 废标体检）：确定性解析,
    按节聚合成 {sec-N: html}。无 LLM、不计费;解析失败抛错由节点层转 run 失败（App 侧退款）。
    没有 state['chapters']（没跑过 content）时,靠 run_input 里的标书文件兜底解析出正文。

    收多份文件（商务标与技术标常常分册出卷）：按传入顺序逐份解析再拼接（节号见 _aggregate）。

    **扫描页先送 OCR**：识别出来的文字按页拼回该文件正文,和别的正文一样参与后续切分与预算
    （OCR 未配置/识别失败 → 原样跳过,见 parsing/ocr.py）。第二项收的是**模型看不见的东西**：
    PDF 报 OCR 之后**仍**有的图片页 [{name, pages, image_pages}],docx 报正文内嵌图片张数
    [{name, embedded_images}]（docx 没有「页」的口径,贴进正文的证照照样一个字都提不出来）。
    审查据此说「无法核验」而不是「缺少」（2026-08-09 生产实测,见 ParsedDoc.image_pages）。
    全部识别成功且没有内嵌图 → 统计为空、注记消失。

    OCR 的时长预算**惰性起算、其后所有文件共享**：起算点是第一份真要识别的文件解析完那一刻,
    在它之前的 MinIO 下载与解析不进预算（10 份大文件的下载 + .doc 转换先把 20 分钟啃掉,
    识别还没开始就报「预算已用光」）;在它之后的一切——含各扫描文件为识别做的**二次下载**
    （ocr_scanned_pages 要把字节重新取一次）——都吃在这条预算里。
    共享而不是每份各开一份:独立审查一次最多收 10 份标书,各开 20 分钟最坏就是 200 分钟——
    用户在一个已预扣积分的步上干等几小时,而心跳还一直说它活着。
    """
    out: dict[str, str] = {}
    scanned: list[dict] = []
    deadline: float | None = None
    for key in _key_list(keys):
        name = key.rsplit("/", 1)[-1]
        parsed = await asyncio.to_thread(read_and_parse, key)
        if deadline is None and needs_ocr(parsed, key):
            deadline = ocr_deadline()          # 第一份真要识别的文件到手,此刻才开表
        # 先扫描页后内嵌图：一份文件只会走其中一条（PDF 有页、docx 有图），顺序在实际数据上
        # 无差别；写成固定顺序是为了让"预算怎么花的"可预期——真要有既有扫描页又有内嵌图的
        # 格式出现，页是整版材料、图是零散贴图，先花在页上更划算。
        pre_pages, pre_images = parsed.image_pages, parsed.embedded_images
        parsed = await ocr_scanned_pages(parsed, key, _ocr_progress(ctx, name), deadline)
        parsed = await ocr_docx_images(parsed, key, _ocr_progress(ctx, name, "内嵌图片"), deadline)
        # 识别掉的张/页数也要报（2026-08-13 实测：11 张识别了 10，可见性说明只报"剩 1 张
        # 不可见"，审查模型把证照/信用/财务全挂到那一张头上判"无法核验"——识别文字明明
        # 就在正文里；报出"已识别 M"配合审查规则的"识别文字视同可见"才能拆掉这口大锅）。
        # 转换丢图兜底恢复的张数（ocr.py::_recover_lost）计入总账：不计的话正文里的识别
        # 段落比注记报的张数多，审查模型对不上账
        rec_pages = pre_pages - parsed.image_pages
        rec_images = (pre_images + parsed.meta.get("recovered_images", 0)
                      - parsed.embedded_images)
        if parsed.image_pages or rec_pages:
            entry = {"name": name, "pages": parsed.pages or parsed.image_pages,
                     "image_pages": parsed.image_pages}
            if rec_pages:
                entry["recognized_pages"] = rec_pages
            scanned.append(entry)
        elif parsed.embedded_images or rec_images:
            entry = {"name": name, "embedded_images": parsed.embedded_images}
            if rec_images:
                entry["recognized_images"] = rec_images
            scanned.append(entry)
        _aggregate(parsed, out)
    return out, scanned


def _ocr_progress(ctx, name: str, what: str = "扫描页"):
    """扫描件识别的阶段播报（长识别期间前端横幅不能一动不动）。ctx 缺省 → 不播报。
    what 是识别的东西（扫描页 / 内嵌图片），两条链路各自报自己的进度。
    run 的**存活心跳**与此无关：runtime/executor.py 的 _heartbeat_pump 是独立泵，
    节点内不产事件也照样续期，OCR 段天然被覆盖，不会被清道夫当孤儿回收。"""
    if ctx is None:
        return None

    async def _report(done: int, total: int) -> None:
        await publish_phase(ctx, f"识别《{name}》的{what} {done}/{total}", done, total)

    return _report


def parse_bid_chapters(keys: str | list[str]) -> dict[str, str]:
    """只要正文（述标用；聚合口径同 parse_bid_docs）——述标不消费扫描页统计，
    也**不做扫描页 OCR**：证照/签字页对讲标 PPT 没有信息量，却要花掉整份文件的识别时间。"""
    out: dict[str, str] = {}
    for key in _key_list(keys):
        _aggregate(read_and_parse(key), out)
    return out


async def upload_artifact(ctx, filename: str, data: bytes, content_type: str) -> str:
    """终产物统一落 MinIO：artifacts/<thread_id>/<filename>，返回 key。present/export 共用。"""
    key = f"artifacts/{ctx.thread_id}/{filename}"
    await storage.put_bytes(key, data, content_type=content_type)
    return key


async def fetch_master_bytes(key: str | None) -> bytes | None:
    """企业自有 .pptx/.potx 母版按 MinIO key 预取字节；present（首渲）/export（重渲）共用。
    缺 key 或取失败（网络抖动/坏 key/未上传）→ 记警告日志并回 None——render_pptx 自身在母版
    加载/渲染失败时也会回退空白设计，这里再兜一层，双保险不阻断述标/导出产出。"""
    if not key:
        return None
    try:
        return await asyncio.to_thread(storage_read.read_bytes, key)
    except Exception:
        logger.warning("企业母版拉取失败 key=%s", key, exc_info=True)
        return None


def package_scope(run_input: dict | None) -> str:
    """run_input.package 存在时的范围约束文本（spec324）：outline/content 共用，追加在用户
    消息末尾；未选包（缺省）时返回空串，用户消息与此前逐字节一致。"""
    package = (run_input or {}).get("package") or {}
    if not package:
        return ""
    name = package.get("name", "")
    pid = package.get("id", "")
    return (f"\n本项目仅投包件《{name}》({pid})：提纲/正文仅覆盖该包件的需求、评分与构成，"
            "其它包件内容一律忽略；涉及分包件评分表/偏离表仅取该包件。")


def _pkg_id(run_input: dict | None) -> str | None:
    return ((run_input or {}).get("package") or {}).get("id") or None


def filter_read_by_package(read: dict, run_input: dict | None) -> dict:
    """选包时把读标结论收窄到该包(spec324 上下文优化):保留 packages 为空(全包通用)或含所选包 id 的条目,
    别的包专属条目丢弃——喂给 LLM 的上下文从「全部包」缩到「单包」,大标书速度/成本降 2-3 倍。
    未选包(单包/缺省) → 原样返回,行为逐字节不变。categories.items / scoring / required_structure 三处过滤。"""
    pid = _pkg_id(run_input)
    if not pid:
        return read

    def keep(it: dict) -> bool:
        pk = it.get("packages") or []
        return not pk or pid in pk

    out = dict(read)
    out["categories"] = [{**c, "items": [i for i in c.get("items", []) if keep(i)]}
                         for c in read.get("categories", [])]
    out["scoring"] = [s for s in read.get("scoring", []) if keep(s)]
    if "required_structure" in read:
        out["required_structure"] = [s for s in read.get("required_structure", []) if keep(s)]
    return out


def slim_read(read: dict) -> dict:
    """白名单出下游提示词需要的读标字段（项目信息/分类/评分表/红线），
    并裁掉 source_quote（原文摘录，token 大头）。outline / review 共用。"""
    cats = [{**c, "items": [{k: v for k, v in it.items() if k != "source_quote"}
                            for it in c.get("items", [])]}
            for c in read.get("categories", [])]
    return {"project_meta": read.get("project_meta", {}), "categories": cats,
            "scoring": read.get("scoring", []), "risk_summary": read.get("risk_summary", [])}


# 正文里内联的图片：`<img src="data:image/jpeg;base64,……">`，单张就有二十万字符。
# 审查每章只喂前 4000 字符，图片一出现，后面的正文一个字都进不了模型——用户把营业执照
# 以图片形式放进正文，审查却报「缺少该材料」（2026-08-06 用户反馈，230 实测坐实）。
# 喂模型/扫描之前一律换成短占位符：既不吃截断预算，也让模型知道这里确实有一张图。
# **只用于构造模型输入**；存库与导出仍保留真图。
_IMG_RE = re.compile(r"<img\b[^>]*>", re.I | re.S)
_ALT_RE = re.compile(r'\balt\s*=\s*["\']([^"\']*)["\']', re.I)
_GENERIC_ALT = {"", "插图", "图片", "image", "img"}


def strip_inline_images(html: str | None) -> str:
    """把 <img …> 换成系统注记。alt 是默认值（插图）时不带说明——重复没有信息量。

    注记写成「【系统注记·图片…】」而不是从前的「［图片］」：后者混在正文里像是文档自带的
    编辑残留，模型会据此判用户的标书「有多余标记、未作清理」（见 SYSTEM_NOTE_PREFIX）。"""
    if not html:
        return ""

    def _sub(m: re.Match) -> str:
        alt = (_ALT_RE.search(m.group(0)) or [None, ""])[1] if _ALT_RE.search(m.group(0)) else ""
        alt = (alt or "").strip()
        inner = f"·图片 {alt}】" if alt and alt.lower() not in _GENERIC_ALT else "·图片】"
        return SYSTEM_NOTE_PREFIX + inner

    return _IMG_RE.sub(_sub, html)


# 单章保底：再多的章也要让每章有点内容，否则等于没看
MIN_CHAPTER_CHARS = 1_000

# 章节正文喂不下、被额度截断处补的系统注记（见 allocate_chapter_budget）。
# 短：150 节的线下标书每节都补一条，注记本身就是几千字的开销，它含义由提示词讲一次即可。
_TRUNCATED_NOTE = "…" + SYSTEM_NOTE_PREFIX + "·截断】"


def chapters_budget(ctx, fixed_text: str) -> int:
    """本次调用留给正文的额度（字符），review / present 共用。

    额度 = 模型窗口 − 输出配额 − fixed_text（系统提示 + 读标结论 + 各类约束）− schema − 余量。
    **不写死常量**：读标结论的大小随招标文件浮动（实测中位 17810 tokens、最大 197002），
    固定值要么砍不够照样 400，要么砍过头——中位项目本来放得下 4.7 万 tokens 的正文。

    窗口取运营后台下发的 model_context_window；没配置时 budget 侧兜底 131072。
    token 估算按中文 1 字 1 token（实测 0.87，留 15% 余量），故额度直接当字符数用。
    """
    s = getattr(ctx.gateway, "s", None)
    return chapter_budget(fixed_text,
                          context_window=getattr(s, "model_context_window", None),
                          max_tokens=getattr(s, "model_max_tokens", None))


def allocate_chapter_budget(texts: dict[str, str], total: int, floor: int) -> dict[str, str]:
    """在总量上限内给各章分配可喂给模型的字数。

    **为什么不是"每章固定上限"**：那个口径对线下标书是灾难——上传的标书常常整本解析成一章。
    2026-08-07 实测一份 75425 字的响应文件只解析出 1 章，按每章 4000 字截断后模型只看到 5%，
    剩下 95% 的内容全被判成"缺失"，用户拿到一堆"实际文件里都有"的假风险。

    分配用注水法：短章按原样全给（它们占不满份额），省下的额度自动匀给长章。
    这样 1 章的文档能整本进去，多章文档也不会因为某一章特别长就把别人挤没。
    截断处补一条系统注记，让模型知道后面还有，而不是当成写完了（写成注记而非「…（截断）」
    的理由同 strip_inline_images：裸标记会被当成用户文件里的残留物报出来）。
    """
    if not texts:
        return {}
    # 单章保底不能高过均分份额，否则章一多，总量就形同虚设：150 章 × 1000 字保底 = 15 万字，
    # 无论 total 给 4 万还是 1 万都照样吐 15 万（收缩重试三轮发的是同一条消息，白烧两轮还是 400）。
    # 线下标书每个标题解析成一节，90 多节是常态，这条路一点都不偏门。
    floor = max(1, min(floor, total // len(texts)))
    remaining, out = total, {}
    pending = dict(texts)
    while pending:
        share = max(floor, remaining // len(pending))
        short = {k: v for k, v in pending.items() if len(v) <= share}
        if not short:                       # 剩下的都超额：按当前份额一刀切
            # 注记的字数**从份额里扣**，不是加在份额之上：150 节的线下标书每节各加一条，
            # 加法口径下总量会超出预算 150 条注记那么多——正是"缩多少轮都装不进去"的来源之一。
            body = max(1, share - len(_TRUNCATED_NOTE))
            for k, v in pending.items():
                out[k] = v[:body] + _TRUNCATED_NOTE
            break
        for k, v in short.items():          # 短章全给，把省下的额度让给长章
            out[k] = v
            remaining -= len(v)
            pending.pop(k)
    return out


_CELL_END = re.compile(r"</(?:td|th)\s*>", re.I)
_BLOCK_END = re.compile(r"</(?:p|div|h[1-6]|li|tr|table|thead|tbody|blockquote)\s*>", re.I)
_ANY_TAG = re.compile(r"<[^>]+>")


def html_to_review_text(html: str | None) -> str:
    """章节 HTML → 喂给审查模型的紧凑文本。

    审查按章截断（_CHAPTER_CAP），而**标签同样占额度**：2026-08-07 全量实测，喂进去的
    2066168 字符里只有 924829 是正文，**56% 花在 HTML 标签上**。表格类章节尤其离谱——
    有一章正文才 5261 字、本来完全放得下 4000 的额度，却因为 <td>/<tr> 把串撑到 38431，
    模型只读到 561 字（10%）。不是章节太长，是额度被标签吃了。

    只剥不改结构：单元格之间留空格、行与段落留换行——审查要靠表格行判断
    「★条款有没有逐条登进偏离表」，把表格压成一坨连续文字就查不出来了。
    连接符只能是空格，不能是 " | "：前端把审查发现定位到章内原文时会先对锚点原文和章节正文
    做同一套归一化再比对，那套归一化会吞掉空格却不吞竖线——发现原文摘自这段紧凑文本、
    真源头是表格行时，"|" 会原样留在归一化后的两侧，永远比对不上，定位退化成"只到章顶"。
    """
    s = strip_inline_images(html)          # 必须先做：图片要留下 alt（证照识别文字在里面）
    s = _CELL_END.sub(" ", s)
    s = _BLOCK_END.sub("\n", s)
    s = _ANY_TAG.sub("", s)
    s = unescape(s)                        # &nbsp;/&amp; 一个实体就占 5–6 字符，表格里成片出现
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n[\s\n]*", "\n", s)
    return s.strip()


# 单章 AI 改写：原章 HTML 整个喂给模型、再用模型输出**整章替换**。内联图片是 base64
# （实测单张 20 万字符），模型既读不懂也不可能原样吐回——一次改写，用户放进正文的营业执照
# 就没了。这不是"识别不到"，是数据丢失。故喂之前换成短标记、拿回输出后再换回原标签。
_MARKER_RE = re.compile(r"［图片(\d+)[^］]*］")


def protect_images(html: str | None) -> tuple[str, dict[int, str]]:
    """<img …> → ［图片N：alt］，并返回 N → 原始标签。标记带 alt，模型才知道这里是什么、不该删。"""
    keep: dict[int, str] = {}
    if not html:
        return "", keep

    def _sub(m: re.Match) -> str:
        n = len(keep) + 1
        keep[n] = m.group(0)
        alt = (_ALT_RE.search(m.group(0)) or [None, ""])[1] if _ALT_RE.search(m.group(0)) else ""
        alt = (alt or "").strip()
        return f"［图片{n}：{alt}］" if alt else f"［图片{n}］"

    return _IMG_RE.sub(_sub, html), keep


def restore_images(html: str, keep: dict[int, str]) -> str:
    """把标记换回原始 <img>。模型漏写的标记，其图片补到末尾——
    位置不完美用户还能挪，凭空消失则是把人家的证照弄丢了。"""
    if not keep:
        return html
    used: set[int] = set()

    def _sub(m: re.Match) -> str:
        n = int(m.group(1))
        tag = keep.get(n)
        if tag is None:
            return m.group(0)   # 模型自己编的编号，原样留着，别吞用户文字
        used.add(n)
        return tag

    out = _MARKER_RE.sub(_sub, html)
    missing = [keep[n] for n in sorted(keep) if n not in used]
    return out + "".join(missing)


# 读标结论最多占输入预算的一半，另一半留给标书正文。
# 2026-08-08 实测：最大的一份读标结论 210311 tokens（2747 个条目），单它一个就是窗口的两倍，
# 正文一个字都放不进去——这种项目只截正文是没用的，得先压结论本身。
_READ_SHARE = 0.5
# 普通条目压缩后保留的取值长度：够模型知道"有这么个要求"，不够的它会从正文里找。
_PLAIN_VALUE_CHARS = 60


def _item_for_model(it: dict, value_chars: int | None) -> dict:
    """条目 → 喂模型的形状。**丢掉 clause_ids**：审查/述标的产出里不需要条款 id
    （风险项用的是文字 tender_ref），而它既占 10% 的量，又是模型把内部编号抄进
    用户可见文字的源头（2026-08-08 全库实测四处泄露）。"""
    out = {k: v for k, v in it.items() if k not in ("clause_ids", "packages", "source_quote")}
    if value_chars is not None and len(out.get("value") or "") > value_chars:
        out["value"] = out["value"][:value_chars] + "…"
    return out


def compress_read(read: dict, budget_tokens: int) -> dict:
    """把读标结论压进额度，按「损失从小到大」逐级降级：

    ① 原样（已去掉 clause_ids/原文摘录）→ ② 普通条目的取值截短 →
    ③ 普通条目只留标题 → ④ 只留 ★条款与废标风险条。

    ★与风险条**任何一级都不动**：它们漏一条就是废标，而普通条目模型还能从正文里看到。
    实测最大那份 2747 条里只有 198 条是 ★/风险，压到第 ④ 级是 12074 tokens（降 94%）。
    """
    cap = int(budget_tokens * _READ_SHARE)
    keep = lambda it: bool(it.get("star") or it.get("risk"))

    def build(value_chars: int | None, plain: bool) -> dict:
        cats = [{**c, "items": [_item_for_model(i, None if keep(i) else value_chars)
                                for i in c.get("items", []) if plain or keep(i)]}
                for c in read.get("categories", [])]
        # 评分行同样带 clause_ids——只清条目不清它，编号照样进模型（也照样可能被抄进报告）。
        scoring = [_item_for_model(s, None) for s in read.get("scoring", [])]
        return {**read, "categories": cats, "scoring": scoring}

    for value_chars, plain in ((None, True), (_PLAIN_VALUE_CHARS, True), (0, True), (None, False)):
        out = build(value_chars, plain)
        if estimate_tokens(json.dumps(out, ensure_ascii=False)) <= cap:
            return out
    return out   # 压到只剩★/风险仍超额：交给 run_with_shrink 的收缩重试兜底


# 内部条款 id 的字段名。这些 id 是**我们自己的键**（sec-19-c129），用来让前端点回招标原文定位；
# 评委看不懂，写进标书就是废纸。
_CLAUSE_ID_FIELDS = ("clause_ids", "evidence_clause_ids")


def strip_clause_ids(obj):
    """递归剥掉内部条款 id 字段——**喂模型之前统一过一遍**。

    规则很简单：**内部 id 只在提纲这一步进出模型**。提纲条目要产出 clause_ids（前端靠它
    点回原文定位），所以提纲步必须看得见；正文/审查/述标的产出里没有任何承载 id 的字段，
    给了只会被抄进交付文档。

    为什么不能只靠"抹掉输出"：2026-08-08 用户截图，偏离表整整一列印着 sec-19-c129…，
    而那一列正是提示词点名要的（"招标要求条款（章节号/clause_ids）"）——模型是照做的。
    事后清洗只能把那些格子抹空，留下一个有表头、内容全空的列，比原样更难看。
    模型看不见，才不会写出来。
    """
    if isinstance(obj, dict):
        return {k: strip_clause_ids(v) for k, v in obj.items() if k not in _CLAUSE_ID_FIELDS}
    if isinstance(obj, list):
        return [strip_clause_ids(v) for v in obj]
    return obj


def chapters_in_outline(chapters: dict, outline: dict) -> dict:
    """只保留提纲里还在的章。

    state 里的 chapters 是**合并**语义（单章改写只更新一章，不能覆盖全量），代价是
    用户在提纲里删掉的章、以及早期版本混进来的杂项键（实测有一条 README.md），
    会一直留在状态里。导出按提纲遍历取稿，天然忽略它们；但另外两处会当真：
      · 审查照单全收地喂给模型 → 对**不会交付的内容**做体检，报出用户在文档里找不到的风险；
      · 计费按结果里所有字符串的字数分档 → 已删掉的章仍计入，可能把用户顶到更高一档。
    提纲为空（线下标书审查/述标这类没有提纲的项目）→ 只滤墓碑,不按提纲过滤。
    None 是缺章墓碑（content 部分交付时用它覆掉上一代旧稿,见 content_node）——
    对外结果/审查/计费一律当"没有这一章"。
    """
    ids = {c.get("id") for c in (outline or {}).get("chapters", []) if c.get("id")}
    if not ids:
        return {k: v for k, v in (chapters or {}).items() if v is not None}
    return {k: v for k, v in (chapters or {}).items() if k in ids and v is not None}
