from __future__ import annotations
import asyncio
import json
import logging
import re
from agent.framework.create_agent import build_create_agent
from langchain_core.messages import HumanMessage
from agent.agents.bidding_agent.nodes.common import (
    filter_read_by_package, protect_images, restore_images,
    publish_phase,
)
from agent.agents.bidding_agent.prompts.content import (
    CHAPTER_DRAFT_PROMPT, REWRITE_PROMPT,
    DEVIATION_TABLE_GUIDE, TEMPLATE_GUIDE)
from agent.agents.bidding_agent.nodes.form_locate import (
    _looks_like_form_title, build_form_index, dedupe_nested, find_form_segment,
    segment_text, slice_single_form)
from agent.rag import retrieve as rag_retrieve
from agent.agents.bidding_agent.render.sanitize import strip_document_shell, strip_chat_wrapper, clean_internal_ids

logger = logging.getLogger(__name__)

_REWRITE_QUERY_CHARS = 200   # 改写检索 query 取原章前 N 字，避免整章 HTML 顶穿 embed 输入
_DEVIATION_KEYWORD = "偏离"          # 偏离表章节识别关键字（技术偏离表/商务偏离表，spec322）
_DEVIATION_CATEGORY_KEYS = ("technical", "commercial", "qualification")


def _default_top_k(run_input: dict) -> int:
    return (run_input.get("rag") or {}).get("top_k") or 3   # spec/seed 默认 3；App 恒发 3


async def _rag_on(ctx, run_input: dict) -> bool:
    """gate 兜底：rag_enabled 抛错也视为 RAG off，检索故障绝不阻断正文生成（降级铁律）。"""
    try:
        return await rag_retrieve.rag_enabled(ctx.user_id, run_input)
    except Exception:  # noqa: BLE001
        logger.warning("rag gate raised, treating as disabled", exc_info=True)
        return False


def _outline_queries(outline: dict | None) -> list[str]:
    """提纲每章标题 + items label 拼一条 query（章粒度），供全局参考资料检索。"""
    queries = []
    for chapter in (outline or {}).get("chapters", []):
        # 展平含小节（三级提纲）：小节 label 是最具体的检索词,漏掉会让密集章检索退化
        labels = " ".join(item.get("label", "") for item in _iter_items(chapter.get("items", [])))
        queries.append(f"{chapter.get('title', '')} {labels}".strip())
    return queries


def _deviation_structure_ids(structure: list[dict]) -> set[str]:
    """required_structure 中标题含「偏离」的构成项 id 集合（如「技术偏离表」「商务偏离表」，spec321 带入）。"""
    return {s.get("id") for s in structure if _DEVIATION_KEYWORD in (s.get("title") or "")}


def _has_deviation_chapters(outline: dict, structure: list[dict]) -> bool:
    """识别偏离表类章节（spec322）：标题含「偏离」，或 structure_ref 指向标题含「偏离」的构成项。"""
    dev_ids = _deviation_structure_ids(structure)
    for chapter in (outline or {}).get("chapters", []):
        if _DEVIATION_KEYWORD in (chapter.get("title") or ""):
            return True
        if chapter.get("structure_ref") in dev_ids:
            return True
    return False


# 表单类章节识别（构词法 _looks_like_form_title/_core_form_name）与全文表单定位现收在
# form_locate.py（2026-08-12 云上江西模板错位返工时整体搬迁）——判定、检索、切割
# 共用同一份构词法，两处各写一份就会长歪。


_TEMPLATE_CHAPTER_CHARS = 8000    # 单章模板原文上限（格式类文书通常很短，超限截断保上下文）


def _is_form_item(s: dict) -> bool:
    """构成项是否为格式类：读标已把表单类标为 kind=form；标题含格式关键词的也算（读标标漏兜底）。"""
    return s.get("kind") == "form" or _looks_like_form_title(s.get("title") or "")


def _sec_of(clause_id: str) -> str | None:
    """条款 id（sec-N-cM）→ 所属节 id（sec-N）；无 -cM 后缀返回 None。"""
    return clause_id.rsplit("-c", 1)[0] if "-c" in clause_id else None


def _sec_doc_order(sec: str) -> tuple[int, str]:
    """节 id 的文档序排序键：按尾部数字比大小（sec-10 在 sec-2 之后），无数字的排最前并按原串稳定。"""
    m = re.search(r"(\d+)$", sec)
    return (int(m.group(1)) if m else -1, sec)


# 招标文件里集中放格式模板的那一章（「第四章 响应文件相关格式」「投标文件格式」…）。
# 定位不到具体表单时整章兜底——**宁可多给几千字，也不能一个字不给**：什么都不给时模型只能
# 凭常识自创一份表单，用户拿到的标书与招标格式对不上，而废标恰恰卡这里（2026-08-11 实测）。
_FORMAT_CHAPTER_RE = re.compile(r"(响应|投标|应答|磋商|谈判|报价)?文件.{0,4}格式|格式.{0,4}(要求|文本|范本)|相关格式")
_FORMAT_FALLBACK_CHARS = 12000    # 整章兜底的上限：比单表单宽，但不至于顶穿单章预算


def _format_chapter_secs(read: dict) -> list[str]:
    """格式章**整章**的节：命中的章标题，加上它下面所有更深层级的标题，直到下一个同级/更高级标题。

    切分器每遇一个标题就另起一个 sec（parsing/docx_sections._emit），所以「第四章 响应文件相关
    格式」那个 sec 里只有一句章导语（「投标人应按下列格式编制响应文件」），真正的
    「格式一 报价函」「格式二 开标一览表」各在自己的下级 sec 里。只取命中的那一个 sec，
    等于兜了个空——**而且它非空，还会把「没找到模板」的留痕分支顶掉**，比不兜更糟
    （2026-08-12 评审实证）。"""
    headings = read.get("doc_headings") or []
    out: list[str] = []
    for i, h in enumerate(headings):
        if not _FORMAT_CHAPTER_RE.search(str(h.get("title") or "")):
            continue
        level = h.get("level") or 1
        out.append(h.get("sec"))
        for nxt in headings[i + 1:]:
            if (nxt.get("level") or 1) <= level:   # 回到同级/更高级 → 格式章结束
                break
            out.append(nxt.get("sec"))
    return [sec for sec in out if sec]


def _is_deviation_chapter(chapter: dict, structure: list[dict]) -> bool:
    """本章是不是偏离表章（模板保真的排除闸）——查**全量** required_structure 而非表单
    子集：kind=table 的偏离构成项不在 form_items 里，只查子集会让它一边收偏离条目一边
    被模板保真钉死，197 字空壳事故换条路复发（评审 2026-08-13 CONFIRMED）。
    章题与构成项标题都用「偏离表」整词，**不是**裸「偏离」：「无偏离承诺函」是真表单，
    裸词（含 _deviation_structure_ids 的旧口径）会把它的模板保护误杀掉（同日评审
    CONFIRMED）。指引投递侧仍是裸词旧口径——那边多发一段指引是噪音，这边误杀是丢保护，
    宽严各取所需。"""
    if "偏离表" in (chapter.get("title") or ""):
        return True
    ref = chapter.get("structure_ref")
    return any(s.get("id") == ref and "偏离表" in (s.get("title") or "") for s in structure)


def _locate_form_text(chapter: dict, struct: dict | None, title: str,
                      by_sec: dict[str, list[str]]) -> str:
    """定位路一：条款所指的节，取全文后过**单份闸**（slice_single_form）——闸内只切出
    与本章同名的那份，切不出就当没找到。旧的「整节直发」正是把整份采购公告喂成
    "响应函模板"、再被保真机制逐字钉死的事故根源（2026-08-12 云上江西）。
    「无边界=整段即单份」的直通道**只对读标登记的构成项开放**：items 的 clause_ids
    是需求条款引用，指着的常是公告/须知——那些文本恰恰没有表单边界，直通道一开，
    整段磋商须知就成了"报价函模板"（2026-08-13 潍坊回放实证）。
    节按**文档序**（数值）排：字典序把 sec-10 排到 sec-2 前面，切割器按行序开闭段，
    乱序文本会把行算错段（评审 2026-08-13）。"""
    def join(cids: list) -> str:
        secs = sorted({s for cid in cids if (s := _sec_of(cid))}, key=_sec_doc_order)
        return "\n".join(t for sec in secs for t in by_sec.get(sec, []) if t)

    struct_text = join(list((struct or {}).get("clause_ids") or []))
    text = slice_single_form(struct_text, title, allow_whole=True) if struct_text else ""
    if not text:
        item_ids = [cid for it in _iter_items(chapter.get("items", []))  # 含小节:引用可挂第三层
                    for cid in (it.get("clause_ids") or [])]
        item_text = join(item_ids)
        text = slice_single_form(item_text, title, allow_whole=False) if item_text else ""
    return text


def _no_template_entry(chapter: dict, struct: dict | None, title: str) -> dict | None:
    """三条路都空时的留痕。**只有读标明确登记成表单构成项才提醒**：构词法只是猜，猜错时
    那句「未找到本表单的规定格式」会原样印进交付的 docx，出现在一个根本不是表单的章开头
    （2026-08-12 评审实证）。不带 TEMPLATE_GUIDE：十几行「务必照抄」的规则配一份不存在的
    模板，等于请模型编一份出来满足规则。"""
    if struct is None:
        return None
    logger.warning("no tender template located for form chapter %s (%s)", chapter.get("id"), title)
    return {"raw": "", "brief": (
        f"— 招标文件中**未能找到**本章「{title}」对应的格式原文。"
        "请按通行格式起草，并在本章开头加一句醒目提示："
        "「（注意：招标文件中未找到本表单的规定格式，以下为通用格式，"
        "递交前请人工比对招标文件原文）」。")}


def _template_entries(read: dict, outline: dict) -> dict[str, dict]:
    """【招标格式模板】按章精确抠取：招标自带格式（响应函/法代证明/报价一览表/声明函等）的章 →
    其对应原文段（按条款所属节整节取）。返回 {chapter_id: 模板段}，**只发给对应的那一章**——
    旧的整块下发靠标题子串匹配投递，散文章标题恰好出现在别章模板原文里就会错收几万字无关
    模板并当成表单来写（评审 2026-08-08）。投标书必须沿用招标模板，不得自创格式。
    无格式章节/无原文 → 空 dict。
    每章返回 {"brief": 简报段, "raw": 招标模板原文}——raw 是零模型时代（2026-08-14）
    表单章线上稿的**直接来源**（template_html 渲染＋同值填空，模型不再参与），
    也与导出复印机同构；brief 只剩无 raw 的表单形态章（走模型路）在用。"""
    sections = read.get("doc_sections") or []
    if not sections or not outline:
        return {}
    by_sec: dict[str, list[str]] = {}
    for c in sections:
        sec = _sec_of(c.get("id") or "")
        if sec:
            by_sec.setdefault(sec, []).append(c.get("text") or "")
    form_items = {s.get("id"): s for s in (read.get("required_structure") or []) if _is_form_item(s)}
    index = build_form_index(read)   # 全文表单边界索引，各章共用（见 form_locate.py 文档串）
    out: dict[str, dict] = {}
    pending: list[tuple] = []       # (chapter, struct, title)
    located: dict[str, str] = {}    # 章id → 命中的模板文本（各路统一收，集齐后做父子去重）
    structure = read.get("required_structure") or []
    for chapter in outline.get("chapters", []):
        struct = form_items.get(chapter.get("structure_ref"))
        title = chapter.get("title") or ""
        if struct is None and not _looks_like_form_title(title):
            continue
        # 偏离表章**绝不走模板保真**：它有自己的「偏离表指引+条目数据」通路，产出本该是
        # 填满响应的表——保真会把模型填好的偏离表判成"改写模板"，打回招标的空表头
        # （2026-08-13 云上重跑实测：偏离表章只剩 197 字空壳）。判定见 _is_deviation_chapter。
        if _is_deviation_chapter(chapter, structure):
            continue
        text = _locate_form_text(chapter, struct, title, by_sec)
        if not text:
            # 二：全文表单边界索引按章名取单份（「1.响应函」这类编号行、节标题、
            # 无编号表单名行都是边界；含子编号归并、复合章名拆部件匹配）。
            text = segment_text(find_form_segment(index, title))
        pending.append((chapter, struct, title))
        if text:
            located[chapter.get("id")] = text

    # 父子去重在**最终文本**上做,不分命中路径——struct/条款路切出的父段同样连带子块
    #（评审 2026-08-13 CONFIRMED）;只摘被认领的子块,未被认领的兄弟表单留在父段。
    located = dedupe_nested(located)
    for chapter, struct, title in pending:
        text = located.get(chapter.get("id"), "")
        cap, note = _TEMPLATE_CHAPTER_CHARS, f"本章「{title}」对应的招标格式原文"
        exact = bool(text)   # 精确命中 = 这一段**就是本章那一份表单**，可以逐字校验
        if not text:
            # 降级二：整份招标的格式章兜底。给多了模型自己挑，给零它只能编。
            secs = _format_chapter_secs(read)
            text = "\n".join(t for sec in secs for t in by_sec.get(sec, []) if t)
            cap, note = _FORMAT_FALLBACK_CHARS, ("招标文件的「格式」章全文（未能定位到本章"
                                                 f"「{title}」的具体表单，请从中找出对应的一份照它写）")
        if not text:
            entry = _no_template_entry(chapter, struct, title)
            if entry is not None:
                out[chapter.get("id")] = entry
            continue
        # raw 只在**精确命中本章那一份表单**时给：走了格式章整章兜底的话，这一段里装着
        # 报价函+授权书+声明函等好几份，而模型正确的做法是只写其中一份——拿整章去逐字校验，
        # 单份表单必然判不过，于是每个表单章都被换成整份格式章的转储，同一份格式章在标书里
        # 重复 N 遍、一个填好的表单都没有，比不做这个校验糟得多（2026-08-12 评审实证）。
        # 也**不带截断标记**：raw 只用于校验与零模型渲染，带上「…（超长截断）」会把这个
        # 内部标记原样印进交付的 docx（本仓已为同类泄漏返工过一次，任务 #96）。
        raw = text if exact else ""
        brief_text = text if len(text) <= cap else text[:cap] + "…（超长截断）"
        if len(text) > cap:
            logger.warning("template entry truncated at chapter %s", chapter.get("id"))
        out[chapter.get("id")] = {"brief": f"{TEMPLATE_GUIDE}\n— {note}：\n{brief_text}", "raw": raw}
    return out


# 篇幅权重信号（spec330 方案3）：投标里最硬的「重要度」是招标评分办法——分在哪，字就该堆在哪。
# 故各章字数预算按「映射到该章的评分分值之和」加权（分高的方案章多写、概述/术语少写）。
# 「投标报价」类评分排除：报价是数字/表格非正文，按分值给它大预算会填不满——报价章只拿基线。
# 无可用评分信号时回退组级加权（技术标 _TECH_SHARE / 商务标其余）。
_TECH_SHARE = 0.8
_PRICE_CATEGORY = "投标报价"


def _scores_per_chapter(chapters: list[dict], scoring: list[dict]) -> dict[str, float]:
    """非报价类评分分值按 chapter_id（回退 clause_ids 重叠）累加到各章。返回 {chapter_id: 分值和}。"""
    ids = {c.get("id") for c in chapters}
    clause_to_ch: dict[str, str] = {}
    for c in chapters:
        for it in _iter_items(c.get("items") or []):  # 含小节:评分行经条款回退定位不得漏第三层
            for cid in (it.get("clause_ids") or []):
                clause_to_ch.setdefault(cid, c.get("id"))
    out: dict[str, float] = {}
    for r in scoring:
        if r.get("category") == _PRICE_CATEGORY:
            continue
        ch = r.get("chapter_id")
        if ch not in ids:  # chapter_id 缺失/不匹配 → 按条款重叠回退定位
            ch = next((clause_to_ch[cid] for cid in (r.get("clause_ids") or []) if cid in clause_to_ch), None)
        if ch in ids:
            out[ch] = out.get(ch, 0.0) + float(r.get("score") or 0)
    return out


def _scoring_weighted_budgets(chapters: list[dict], target: int, score_by_ch: dict[str, float]) -> dict[str, int]:
    """评分权重版：各章权重 = 基线 + 该章非报价评分分值和；基线≈平均分 1/3（无评分章的下限，避免被饿死）。"""
    base = sum(score_by_ch.values()) / (len(chapters) * 3)
    weights = {c.get("id"): base + score_by_ch.get(c.get("id"), 0.0) for c in chapters}
    total_w = sum(weights.values()) or 1
    return {cid: max(300, round(target * w / total_w / 100) * 100) for cid, w in weights.items()}


def _iter_items(items: object, _depth: int = 0) -> "list[dict]":
    """提纲子项全深度展平（二～五级）：预算计数/RAG query/模板定位/评分回退共用的唯一口径。
    必须递归到底——四、五级子项同样带 clause_ids,只展两层会让拆得深的章丢掉条款引用
    （模板原文定位不到、评分回退漏项）,且 _item_count 少算规模、把它的字数预算越拆越小。
    类型钳制（评审:API 对 items 内部零校验,children 可能被 PATCH 存成任意垃圾）:
    非 list/非 dict 一律跳过,绝不让脏数据把付费 content 步炸在预算规划;
    深度封顶 8 层,挡住脏数据里自引用造成的无限递归。"""
    out: list[dict] = []
    if _depth > 8:
        return out
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        out.append(it)
        out.extend(_iter_items(it.get("children"), _depth + 1))
    return out


def _item_count(items: object) -> int:
    """提纲子项计数（含小节）：预算权重的规模口径。"""
    return len(_iter_items(items))


def _group_weighted_budgets(chapters: list[dict], target: int) -> dict[str, int]:
    """回退：无可用评分信号时，技术标组占 _TECH_SHARE / 商务标组占其余，组内按子项权重分。单组则独占。"""
    tech = [c for c in chapters if c.get("group") == "tech"]
    biz = [c for c in chapters if c.get("group") != "tech"]  # 非 tech 一律归商务侧（含未标组）
    both = bool(tech) and bool(biz)
    budgets: dict[str, int] = {}
    for chs, share in ((tech, _TECH_SHARE if both else 1.0), (biz, 1 - _TECH_SHARE if both else 1.0)):
        if not chs:
            continue
        # 子项数含小节（三级提纲）：children 多的章实质内容量更大,预算权重同步放大
        weights = [max(1, _item_count(c.get("items") or []) + 1) for c in chs]
        total_w = sum(weights)
        for c, w in zip(chs, weights):
            budgets[c.get("id")] = max(300, round(target * share * w / total_w / 100) * 100)
    return budgets


def _chapter_budget_map(run_input: dict, outline: dict,
                        scoring: list[dict] | None = None) -> tuple[dict[str, int], int]:
    """各章字数预算表（spec330 方案3,流水线口径）：用户目标 ÷ 超写校准 = 全书工作目标,
    再按评分分值加权拆到章（「投标报价」类评分排除,无评分信号回退组级+子项权重）。
    返回 ({chapter_id: 目标字数}, 全书工作目标)；未配置目标返回 ({}, 0)。
    逐章简报只取**本章那一行**下发——整表下发会把内部章 id（t3/b2）漏给写手（评审 2026-08-08 提出）。"""
    target = run_input.get("target_chars")
    chapters = outline.get("chapters") or []
    if not isinstance(target, int) or target <= 0 or not chapters:
        return {}, 0
    work = max(1000, round(target / _calibration(run_input) / 100) * 100)
    score_by_ch = _scores_per_chapter(chapters, scoring or [])
    budgets = (_scoring_weighted_budgets(chapters, work, score_by_ch)
               if sum(score_by_ch.values()) > 0 else _group_weighted_budgets(chapters, work))
    return budgets, work


# 篇幅超写校准:下发的工作目标 = 用户目标 ÷ 本系数。
# 1.4 是 2026-07-28 在**旧引擎 + 旧"±20% 写足"提示词**下量的（那时写手系统性超写 ~40%,
# 目标 5.6 万实际产出 ~7.9 万;记录见 apps/web/lib/page-estimate.ts 文件头）。
# 2026-08-09 生产实测（230 遥测):新流水线提示词已把写手钉在「上限 +10%」,超写整个消失,
# produced/work≈0.68~1.0——÷1.4 于是从"抵消超写"退化成纯打折,与写手自身的偏欠相乘,
# 用户选 5.1 万字只拿到 48%。本次同时把【篇幅】行改成**双边带**（下限 90%/上限 +10%）
# 并给短章加了一轮扩写兜底,校准就该回归中性,不再替提示词背书。
# 运营可经 run_input.overshoot_calibration 覆盖（App 从 billing_configs 的
# generation.overshoot_calibration 读出下发),不必发版——该通道原样保留;本常量只是未配置时的默认。
_OVERSHOOT_CALIBRATION = 1.0


def _calibration(run_input: dict) -> float:
    """超写校准系数:运营配置（run_input 下发)优先,非法/缺省回落默认;夹在 [1.0, 3.0] 防手滑。"""
    try:
        v = float(run_input.get("overshoot_calibration") or _OVERSHOOT_CALIBRATION)
    except (TypeError, ValueError):
        return _OVERSHOOT_CALIBRATION
    return min(3.0, max(1.0, v))


def _visible_len(html: str) -> int:
    """与前端 countChars 同口径的可见字符数（去标签→实体折空格→去空白）：
    超写比值必须和用户在页面上看到的字数同尺度,才能直接用于调 overshoot_calibration。"""
    text = re.sub(r"<[^>]+>", "", html)
    text = re.sub(r"&[a-z#0-9]+;", " ", text, flags=re.I)
    return len(re.sub(r"\s+", "", text))


async def _log_length_telemetry(ctx, run_input: dict, chapters: dict[str, str]) -> None:
    """篇幅遥测（评审 F2 兜底）：pdf_pages 只有页数,密度误差和超写偏差混在一起分不开——
    这里把「产出可见字数 vs 工作目标/用户目标」落 observability 事件（agent.agent_event,可查询),
    校准系数据此双向调（偏欠也看得见）。生产 root logger 是 WARNING,logger.info 在生产
    **看不见**（运维铁律）——遥测必须落库,日志只作本地开发兜底。best-effort,绝不阻断交付。
    落库走 to_thread（与 executor/export 同款）:log_event 是同步 PG 写且先拿 per-run advisory 锁,
    直接在事件循环上调会与同 run 的并发埋点争锁,卡住单进程全部 SSE。"""
    target = run_input.get("target_chars")
    if not isinstance(target, int) or target <= 0 or not chapters:
        return
    produced = sum(_visible_len(h) for h in chapters.values())
    work = max(1000, round(target / _calibration(run_input) / 100) * 100)
    logger.info("length telemetry: target=%d work=%d produced=%d produced/work=%.2f produced/target=%.2f",
                target, work, produced, produced / work, produced / target)
    try:
        if ctx.recorder and ctx.run_id:
            await asyncio.to_thread(
                ctx.recorder.log_event,
                ctx.run_id, ctx.agent_type, "length_telemetry", node="content",
                data={"target": target, "work": work, "produced": produced,
                      "produced_over_work": round(produced / work, 3),
                      "produced_over_target": round(produced / target, 3)},
                thread_id=ctx.thread_id,
            )
    except Exception:  # noqa: BLE001 遥测落库失败绝不影响正文交付
        logger.warning("length telemetry event write failed", exc_info=True)


def _clause_source(read: dict, clause_ids: list | None) -> str:
    """内部条款 id → **招标文件自己的章节标题**（读标产出的 doc_headings）。

    这是"用人看得懂的引用替换内部键"的那一步：模型需要的是能写进偏离表、评委能对照的出处，
    而 sec-19-c129 对评委毫无意义。取第一个 id 所在节的标题；找不到就不给这个字段——
    宁可留空，也不要让模型对着一个空列去编条款号。"""
    if not clause_ids:
        return ""
    sec = str(clause_ids[0]).rsplit("-c", 1)[0]
    for h in read.get("doc_headings") or []:
        if h.get("sec") == sec:
            return str(h.get("title") or "")
    return ""


# 偏离表条目段字符预算：大标书几百条会把偏离章那一次调用顶穿上下文（评审 2026-08-08——
# content 是唯一没有 run_with_shrink 保护的调模型节点,400 后重试同一报文必然再 400）。
_DEVIATION_BLOCK_CHARS = 30000


def _deviation_items_block(read: dict) -> str:
    """技术/商务/资格分类条目（title/value/star/出处），供偏离表章逐条落表（spec322）。
    条目 ★ 优先排序后按字符预算截断：偏离表最不能丢的是不可偏离项——预算不够时砍普通条目
    并如实注明,★/▲ 绝不砍。不给 clause_ids（内部键），「出处」给它指向的章节标题——
    否则模型只能留空或编一个条款号,编造的引用印在偏离表里比空格子更糟。"""
    cats, total, dropped = [], 0, 0
    for c in (read.get("categories") or []):
        if c.get("key") not in _DEVIATION_CATEGORY_KEYS:
            continue
        items = []
        for it in sorted(c.get("items", []), key=lambda x: not x.get("star")):
            entry = {"title": it.get("title"), "value": it.get("value"), "star": it.get("star", False),
                     **({"source": src} if (src := _clause_source(read, it.get("clause_ids"))) else {})}
            size = len(json.dumps(entry, ensure_ascii=False))
            if total + size > _DEVIATION_BLOCK_CHARS and not entry["star"]:
                dropped += 1
                continue
            total += size
            items.append(entry)
        cats.append({"key": c.get("key"), "title": c.get("title"), "items": items})
    if dropped:
        logger.warning("deviation block dropped %d non-star items over budget", dropped)
    note = f"（普通条目超出篇幅已省略 {dropped} 条,★/▲ 条目已全量保留）" if dropped else ""
    return (f"{DEVIATION_TABLE_GUIDE}\n"
            f"技术/商务/资格条目（供偏离表逐条落表，不得遗漏 ★/▲）{note}：\n"
            f"{json.dumps(cats, ensure_ascii=False)}")


async def _content_reference_block(ctx, state: dict) -> str:
    """content 是 deepagent 一次规划+写完所有章（架构现实，非逐章循环），spec 的逐章检索不适配——
    改为用 outline 汇成 queries，检索出一段全局参考资料，注入规划轮 user 消息（spec316 A2）。"""
    run_input = state.get("run_input") or {}
    if not await _rag_on(ctx, run_input):
        return ""
    queries = _outline_queries(state.get("outline"))
    return await rag_retrieve.build_reference_block(
        ctx.user_id, queries, _default_top_k(run_input), tender_thread_id=ctx.thread_id)


def _heartbeat_label(done: int, total: int, elapsed_s: float, in_flight: int = 0) -> str:
    """正文心跳文案：横幅每 5s 动一次。

    **不再假装是一章接一章写的**：实测正文是多路并行（2026-08-08 用调用区间算出并发峰值 7 路、
    54% 的调用互相重叠）。旧文案写"第 9/20 章成稿中（本章已 15 分）"，两个数都是错的——
    序号其实是"已完成+1"，计时其实是"距上一章写完多久"。用户读成"这一章卡了 15 分钟"来问，
    而那会儿实际有六七章在同时写、每两三分钟就完成一章。

    现在只说得准的话：完成了几章、此刻有几路在写、这一批写了多久。
    """
    m, s = divmod(int(elapsed_s), 60)
    # **不再带"已完成 N/M 章"**：前端横幅自己会拼这一段（contentRunningText），心跳再带一遍
    # 就显示成"已完成 3/20 章，正文·已完成 3/20 章，撰写中"（2026-08-08 用户截图）。
    # done/total 参数保留：前端拿不到 progress 时（首个 chapter.progress 事件之前）作兜底。
    if in_flight > 0:
        # 计时口径：距上一章收稿多久（chapter_done 时归零）——不是全程累计。
        # 全程累计会显示"本批已 37 分"被读成卡死（评审 2026-08-08,正是用户当晚问过的那种）。
        return f"{in_flight} 章同时撰写中（距上一章收稿 {m} 分 {s:02d} 秒）"
    # in_flight 归零 ≠ 没在干活：断点核对/残章重试的间隙。旧文案"规划章节与分派写手"
    # 描述的是已删除的规划者,叙事失实（评审 2026-08-08）。
    if done == 0:
        return f"正在准备各章写作简报（已 {m} 分 {s:02d} 秒）"
    return f"已收稿 {done} 章，正在核对与收尾（已 {m} 分 {s:02d} 秒）"


def make_content_node(ctx):
    """正文节点：代码编排流水线（任务 #84/#85）——章清单来自提纲、每章一次独立模型调用、
    并发受限、每章落 Redis 断点。编排细节见 content_pipeline.run_content_pipeline。"""
    async def content_node(state):
        from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline
        from agent.agents.bidding_agent.nodes.credentials_chapter import append_credentials_chapter
        await publish_phase(ctx, "逐章撰写投标正文（代码编排）")
        chapters = await run_content_pipeline(ctx, state)
        await _log_length_telemetry(ctx, state.get("run_input") or {}, chapters)  # 超写系数的校准数据源（评审 F2）
        # 资格证明文件附录章（2026-08-09 附录系统章节设计,Plan A①）：命中条件时代码确定性拼出该章并追加进提纲，
        # 零字进模型、不占本轮任何一次模型调用；不命中原样返回 None，outline/chapters 都不动。
        appended = append_credentials_chapter(state, chapters)
        if appended:
            chapters = appended["chapters"]
        outline = appended["outline"] if appended else (state.get("outline") or {})
        # 部分交付防混稿（评审 2026-08-08）：缺章写 None 墓碑,让合并 reducer 覆掉上一代旧稿。
        # 否则重新生成时若 3 章失败,状态里还留着按**旧提纲**写的旧章,交付出一本新旧混杂的
        # "完整"书且照常计费——墓碑在 chapters_in_outline 统一滤掉,对外就是"缺这一章"。
        # 墓碑口径用**追加后**的提纲 ids：sys-creds 刚追加进 outline，必须和它的 html 落在
        # 同一批 ids 里核对，否则会被误判"提纲有此章、chapters 没内容"而错打 None 墓碑。
        ids = [c.get("id") for c in outline.get("chapters", []) if c.get("id")]
        result = {"chapters": {**{cid: None for cid in ids if cid not in chapters}, **chapters}}
        if appended:
            result["outline"] = outline
        return result
    return content_node


async def _rewrite_reference_block(ctx, state: dict, old: str, instruction: str) -> str:
    """rewrite 是真逐章：query 用「原章前 N 字 + 改写指令」检索，命中拼进改写提示词（spec316 A2）。"""
    run_input = state.get("run_input") or {}
    if not await _rag_on(ctx, run_input):
        return ""
    # old 传进来时图片已换成短标记（见 rewrite_chapter），否则这里截前 N 字会截到 base64 中段，
    # 检索词变成一串乱码
    query = f"{old[:_REWRITE_QUERY_CHARS]} {instruction}"
    return await rag_retrieve.build_reference_block(
        ctx.user_id, [query], _default_top_k(run_input), tender_thread_id=ctx.thread_id)


_REWRITE_CTX_CAP = 2000   # 上下文块上限：改写是免费功能，不能把成本堆上去
_REWRITE_REQ_MAX = 12     # 最多列几条招标要求，★ 优先


def _collect_clause_ids(nodes: object, _depth: int = 0) -> set[str]:
    """递归收集提纲子树上的条款 id。

    提纲是五级（节→小节→细分→明细），**每一级都带 clause_ids**；只遍历两层会把四、五级
    的招标依据整片丢掉，而恰恰是拆得最细的那些节点才有明确条款。
    章本身没有 clause_ids 字段（见 schemas.OutlineChapter），所以只从 items 往下走。
    类型钳制 + 深度封顶与 _iter_items 同款：items 内部在 API 层零校验，脏 children
    （裸字符串/自引用）不得把付费 content 步炸在简报构造（评审 2026-08-08 提出）。"""
    out: set[str] = set()
    if _depth > 8 or not isinstance(nodes, list):
        return out
    for n in nodes:
        if not isinstance(n, dict):
            continue
        ids = n.get("clause_ids")
        out |= set(ids) if isinstance(ids, list) else set()
        out |= _collect_clause_ids(n.get("children"), _depth + 1)
    return out


def _chapter_requirements(read: dict, clause_ids: set[str]) -> list[str]:
    """本章对应的招标要求（按 clause_ids 从读标结论里捞），★ 条款排前面。"""
    hits: list[tuple[bool, str]] = []
    for cat in read.get("categories") or []:
        for it in cat.get("items") or []:
            if not (set(it.get("clause_ids") or []) & clause_ids):
                continue
            star = bool(it.get("star"))
            title = (it.get("title") or "").strip()
            value = (it.get("value") or "").strip()
            text = f"{'★ ' if star else ''}{title}{'：' + value if value else ''}"
            hits.append((star, text[:120]))
    hits.sort(key=lambda x: not x[0])          # ★ 在前
    return [t for _, t in hits[:_REWRITE_REQ_MAX]]


def _rewrite_context_block(state: dict, chapter_id: str) -> str:
    """单章改写的上下文。

    改写此前只拿到「原章 HTML + 用户指令」——既不知道本章要响应哪些招标条款，也不知道
    提纲给本章写了什么要求、相邻章节写的是什么。于是改出来的内容可能与招标要求脱节，
    或者把隔壁章的内容又写一遍。正文首次生成时这些信息都是给足的，改写却全丢了。

    只给**本章相关**的部分：全量招标结论有几万字，塞进来既贵又会淹没用户的指令。
    """
    outline = state.get("outline") or {}
    chapters = outline.get("chapters") or []
    idx = next((i for i, c in enumerate(chapters) if c.get("id") == chapter_id), -1)
    if idx < 0:
        return ""
    ch = chapters[idx]
    parts = [f"【本章定位】{ch.get('no') or ''} {ch.get('title') or ''}".strip()]
    if (ch.get("desc") or "").strip():
        parts.append(f"本章写作说明（用户填写，须遵循）：{ch['desc'].strip()}")
    items = [(it.get("label") or "").strip() for it in (ch.get("items") or [])]
    if any(items):
        parts.append("本章应覆盖的小节：" + "、".join(i for i in items if i))
    neighbours = [chapters[i].get("title") or "" for i in (idx - 1, idx + 1) if 0 <= i < len(chapters)]
    if any(neighbours):
        parts.append("相邻章节（内容不要与它们重复）：" + "、".join(n for n in neighbours if n))
    # 选包时必须先按包过滤：多包件招标里同一条款会拆成「包1工期90天」「包2工期120天」两条、
    # 共用同一个 clause_id。不过滤就会把**别的包**的要求当成本章的★不可偏离项写进标书。
    read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
    cids = _collect_clause_ids(ch.get("items"))
    reqs = _chapter_requirements(read, cids) if cids else []
    head = "\n".join(parts)
    if not reqs:
        return head[:_REWRITE_CTX_CAP]
    # 要求块**整块保留，先裁上面的**。若把 head+要求 拼起来再一刀切，先掉的恰是排在最后的
    # ★ 条款，而提示词刚刚向模型保证「★ 改写后必须仍然逐条响应」——那就成了空头承诺。
    # 要求块本身放得下：每条 ≤120 字 × 最多 12 条，加标题也不到 1500，小于上限。
    block = "本章须响应的招标要求（★ 为不可偏离）：\n" + "\n".join(f"- {r}" for r in reqs)
    return (head[: max(0, _REWRITE_CTX_CAP - len(block) - 1)] + "\n" + block).lstrip("\n")


def _chapter_query_seed(state: dict, chapter_id: str, chapter_title: str = "") -> str:
    """补写时用来检索资料库的种子：本章标题 + 提纲条目。
    章标题优先取 App 下发的那份（库里的提纲是权威，图状态里的可能是旧的）。"""
    ch = next((c for c in (state.get("outline") or {}).get("chapters", [])
               if c.get("id") == chapter_id), {})
    parts = [chapter_title or ch.get("title", ""), *(i.get("label", "") for i in ch.get("items") or [])]
    return " ".join(p for p in parts if p)


def _draft_msg(instruction: str, ref: str, chapter_ctx: str = "") -> str:
    """本章还没有正文时的写稿消息：只有本章定位与招标依据可依，没有"原章"。
    用户指令为空（"继续生成"这类批量补写）时不硬塞一句空指令——那会让模型去揣摩空要求。"""
    blocks = [b for b in (chapter_ctx, ref) if b]
    tail = f"\n\n用户补充要求：{instruction}" if instruction.strip() else ""
    return "\n\n".join(blocks) + f"\n\n请按上述定位与要求撰写本章正文（本章此前尚未生成）。{tail}"


def _rewrite_msg(old: str, instruction: str, ref: str, chapter_ctx: str = "") -> str:
    """上下文放在原章之前、指令放在最后：指令是用户当下最想要的，压轴最不容易被淹没。"""
    blocks = [b for b in (chapter_ctx, f"原章 HTML：\n{old}", ref) if b]
    return "\n\n".join(blocks) + f"\n\n改写指令：{instruction}"


async def rewrite_chapter(ctx, chapter_id: str, instruction: str, state: dict,
                          chapter_title: str = "") -> str:
    """单章改写/补写（/content 右栏 AI 对话）：原章 HTML + 用户指令 → 新 HTML。
    走轻量 create_agent，不重规划全本。
    state 传工作流状态**值 dict**（如 `(await graph.aget_state(cfg)).values`），不是 StateSnapshot 本身。

    **本章还没有正文时写初稿，而不是"改写空白"**：正文生成被打断是常态（实测一份 20 章的标书
    停在第 14 章），剩下的章在界面上是「待生成」。此前这里一律走改写提示词——那份提示词从头到尾
    只说"仅就当前章按用户指令改写"，手里却没有原章，模型无从下手；而页面的空章提示语写的是
    "由 AI 生成/改写本章正文"，等于让用户去做一件后端不支持的事。"""
    raw_old = state.get("chapters", {}).get(chapter_id, "")
    # 图片先换成短标记：内联 base64 单张就有二十万字符，直接喂过去模型不可能原样吐回，
    # 而本函数用模型输出**整章替换**——等于一次改写就把用户放进正文的证照弄丢。
    old, kept_images = protect_images(raw_old)
    drafting = not old.strip()
    # 检索用的查询：改写时用原章开头，补写时原章是空的——拿"请按提纲撰写本章正文初稿"这句
    # 模板话去检索，批量补写的每一章都会命中同一堆无关资料。改用本章标题/条目才切题。
    query_seed = (_chapter_query_seed(state, chapter_id, chapter_title) if drafting else old)
    ref = await _rewrite_reference_block(ctx, state, query_seed, instruction if not drafting else "")
    # 补写这条路没绑任何工具，收稿看消息正文——**不能用带 write_file 那版提示词**
    sub = build_create_agent(CHAPTER_DRAFT_PROMPT if drafting else REWRITE_PROMPT, [], ctx)
    msg = (_draft_msg(instruction, ref, _rewrite_context_block(state, chapter_id)) if drafting
           else _rewrite_msg(old, instruction, ref, _rewrite_context_block(state, chapter_id)))
    out = await sub.ainvoke({"messages": [HumanMessage(content=msg)]})
    last = out["messages"][-1]
    # 输出被长度上限截断 → 拒收。改写是**整章替换**，收下半截等于把用户这一章的后半部分删了，
    # 而校验只看"含不含标签"，截断的 HTML 照样过关。实测该信号真实发生过（agent.agent_token_usage
    # 里 finish_reason='length' 共 53 次），信号一直有、只是没人用。
    if (getattr(last, "response_metadata", None) or {}).get("finish_reason") == "length":
        raise RuntimeError(
            "rewrite_truncated: 模型没能完整改写本章（输出被长度上限截断）。已放弃本次改写以免丢失后半章。")
    # 先剥对话包装（开场白/```围栏）再剥文档壳：提示词禁不住模型客套，确定性清洗兜底。
    # 免责语同样要剥（评审 2026-08-14 F10）：改写路是纵深防御注释里点名的"模型路径依赖"通道，
    # 只在流水线剥、这里不剥，免责语会从补齐/改写溜进交付稿。
    from agent.agents.bidding_agent.render.sanitize import strip_template_disclaimers
    new = strip_template_disclaimers(
        clean_internal_ids(strip_document_shell(strip_chat_wrapper(last.content))))
    return restore_images(new, kept_images)
