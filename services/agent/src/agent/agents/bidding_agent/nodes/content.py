from __future__ import annotations
import asyncio
import json
import logging
import re
from typing import Any
from deepagents import create_deep_agent          # 全流程唯一 deepagent 节点（§4.5）
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import HumanMessage
from agent.models.usage import UsageCallback
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.nodes.common import slim_read, package_scope, filter_read_by_package
from agent.agents.bidding_agent.prompts.content import (
    CONTENT_PLANNER_PROMPT, CHAPTER_WRITER_PROMPT, REWRITE_PROMPT, DEVIATION_TABLE_GUIDE, TEMPLATE_GUIDE)
from agent.rag import retrieve as rag_retrieve
from agent.agents.bidding_agent.render.sanitize import strip_document_shell, strip_chat_wrapper
from agent.runtime.channels import progress_stream

logger = logging.getLogger(__name__)


class ChapterProgressCallback(AsyncCallbackHandler):
    """逐章进度埋点:deepagent 每次 write_file 到 chapters/<id>.html 就往进度流推一条 chapter.progress
    事件(done/total + 已完成章 id),前端据此实时勾选「哪章写完、还剩几章」。best-effort,推送失败不影响生成。"""

    def __init__(self, ctx: Any, total: int, titles: dict[str, str]):
        self.ctx = ctx
        self.total = total
        self.titles = titles          # chapter_id → 标题(前端展示用)
        self.done: list[str] = []

    async def on_tool_start(self, serialized, input_str, *, inputs=None, **kwargs):
        # 只认 write_file 工具：deepagent 的 write_todos 等规划工具 input 里也含 "chapters/<id>.html"
        # （todo 项，带 status），之前误判成"写完一章"→ 计数虚高、标题解析成 todo 的 repr 残片。
        name = (serialized or {}).get("name") if isinstance(serialized, dict) else None
        if name and name != "write_file":
            return
        # 结构化 file_path 才是可信来源（write_file 的 inputs.file_path 是干净的 chapters/x.html；
        # write_todos 的 file_path 嵌在 todos 列表里，inputs.get 取不到）。input_str（工具入参 dict repr）
        # 只在"确认是 write_file"时才兜底——否则 write_todos 若 serialized 无 name（绕过上面名字门），
        # 其 repr 里的 todo 项 chapters/<id>.html 会被正则误抠成"写完一章"（虚高计数）。
        path = (inputs or {}).get("file_path") or (inputs or {}).get("path") or ""
        if not path and name == "write_file":
            path = input_str or ""
        m = re.search(r"chapters/([^\"'/\\\s\]\},]+?)\.html", str(path))
        if not m:
            return
        cid = m.group(1)
        if cid in self.done:
            return
        self.done.append(cid)
        ev = {"type": "progress", "data": {"kind": "chapter", "chapterId": cid,
              "title": self.titles.get(cid, cid), "done": len(self.done), "total": self.total,
              "doneIds": list(self.done)}}
        try:
            if self.ctx.redis and self.ctx.run_id:
                await asyncio.to_thread(self.ctx.redis.xadd, progress_stream(self.ctx.run_id),
                                        {"event": json.dumps(ev, ensure_ascii=False)})
        except Exception:  # noqa: BLE001 进度埋点 best-effort,推送失败绝不影响正文生成
            logger.warning("chapter progress publish failed", exc_info=True)

_CHAPTER_PREFIX = "/chapters/"
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
        labels = " ".join(item.get("label", "") for item in chapter.get("items", []))
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


# 招标自带格式章节识别关键词（响应函/投标函/声明函/证明/一览表/简历表/报价表/授权委托等格式类文书）
_FORM_KEYWORDS = ("格式", "响应函", "投标函", "声明", "承诺函", "证明", "一览表", "简历表", "报价表", "授权", "委托")
_TEMPLATE_CHAPTER_CHARS = 8000    # 单章模板原文上限（格式类文书通常很短，超限截断保上下文）
_TEMPLATE_BLOCK_CHARS = 30000     # 整个【招标格式模板】段上限


def _is_form_item(s: dict) -> bool:
    """构成项是否为格式类：读标已把表单类标为 kind=form；标题含格式关键词的也算（读标标漏兜底）。"""
    return s.get("kind") == "form" or any(k in (s.get("title") or "") for k in _FORM_KEYWORDS)


def _sec_of(clause_id: str) -> str | None:
    """条款 id（sec-N-cM）→ 所属节 id（sec-N）；无 -cM 后缀返回 None。"""
    return clause_id.rsplit("-c", 1)[0] if "-c" in clause_id else None


def _template_block(read: dict, outline: dict) -> str:
    """【招标格式模板】：招标文件自带格式（响应函/法代证明/报价一览表/资格声明函等）的章节，
    从 doc_sections 抠出其原文（按条款所属节整节取），随规划轮下发——投标书必须沿用招标模板，
    不得自创格式（用户实测反馈：生成的响应函没有用招标给定的格式）。
    slim_read 裁掉了 doc_sections（防上下文顶穿），这里按需只取格式章节对应的节，篇幅可控。
    无格式章节/无原文时返回空串（规划消息与今天逐字节一致）。"""
    sections = read.get("doc_sections") or []
    if not sections or not outline:
        return ""
    by_sec: dict[str, list[str]] = {}
    for c in sections:
        sec = _sec_of(c.get("id") or "")
        if sec:
            by_sec.setdefault(sec, []).append(c.get("text") or "")
    form_items = {s.get("id"): s for s in (read.get("required_structure") or []) if _is_form_item(s)}
    parts: list[str] = []
    total = 0
    for chapter in outline.get("chapters", []):
        struct = form_items.get(chapter.get("structure_ref"))
        title = chapter.get("title") or ""
        if struct is None and not any(k in title for k in _FORM_KEYWORDS):
            continue
        # 模板原文定位：优先构成项的 clause_ids，回退章内 items 的 clause_ids；取所属节全文
        clause_ids = list((struct or {}).get("clause_ids") or [])
        for it in chapter.get("items", []):
            clause_ids += it.get("clause_ids") or []
        secs = sorted({s for cid in clause_ids if (s := _sec_of(cid))})
        text = "\n".join(t for sec in secs for t in by_sec.get(sec, []) if t)
        if not text:
            continue
        if len(text) > _TEMPLATE_CHAPTER_CHARS:
            text = text[:_TEMPLATE_CHAPTER_CHARS] + "…（超长截断）"
        entry = f"— 章「{chapter.get('id')} {title}」对应的招标格式原文：\n{text}"
        if total + len(entry) > _TEMPLATE_BLOCK_CHARS:
            logger.warning("template block truncated at chapter %s", chapter.get("id"))
            break
        parts.append(entry)
        total += len(entry)
    if not parts:
        return ""
    return TEMPLATE_GUIDE + "\n" + "\n\n".join(parts)


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
        for it in (c.get("items") or []):
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


def _group_weighted_budgets(chapters: list[dict], target: int) -> dict[str, int]:
    """回退：无可用评分信号时，技术标组占 _TECH_SHARE / 商务标组占其余，组内按子项权重分。单组则独占。"""
    tech = [c for c in chapters if c.get("group") == "tech"]
    biz = [c for c in chapters if c.get("group") != "tech"]  # 非 tech 一律归商务侧（含未标组）
    both = bool(tech) and bool(biz)
    budgets: dict[str, int] = {}
    for chs, share in ((tech, _TECH_SHARE if both else 1.0), (biz, 1 - _TECH_SHARE if both else 1.0)):
        if not chs:
            continue
        weights = [max(1, len(c.get("items") or []) + 1) for c in chs]
        total_w = sum(weights)
        for c, w in zip(chs, weights):
            budgets[c.get("id")] = max(300, round(target * share * w / total_w / 100) * 100)
    return budgets


def _chapter_budgets(chapters: list[dict], target: int, scoring: list[dict] | None) -> list[str]:
    """各章字数「建议」预算：优先按评分分值加权（分在哪字在哪）；无可用评分信号回退组级+子项权重。
    百字取整、单章下限 300，原章序输出。总量精确≈target,交主笔按各章实质内容量再微调。"""
    score_by_ch = _scores_per_chapter(chapters, scoring or [])
    budgets = (_scoring_weighted_budgets(chapters, target, score_by_ch)
               if sum(score_by_ch.values()) > 0 else _group_weighted_budgets(chapters, target))
    return [f"- {c.get('id')}「{c.get('title', '')}」目标约 {budgets.get(c.get('id'), 300)} 字" for c in chapters]


def _length_plan_block(run_input: dict, outline: dict, scoring: list[dict] | None = None) -> str:
    """【篇幅规划】（spec330 方案3）：用户选了目标总字数 → 按评分分值加权给各章「建议」预算，随规划轮
    下发；主笔把总目标视作硬目标，在建议上按各章实质内容量微调后派工。未配置返回空串（行为不变）。"""
    target = run_input.get("target_chars")
    chapters = outline.get("chapters") or []
    if not isinstance(target, int) or target <= 0 or not chapters:
        return ""
    lines = _chapter_budgets(chapters, target, scoring)
    return ("【篇幅规划】全书目标约 " + f"{target} 字（硬目标）。下列各章目标是**按招标评分分值加权的建议**"
            "（评分高的方案章多、概述/表单/报价章少）：\n"
            + "\n".join(lines)
            + "\n主笔：以此为起点,再结合各章**实质内容量**上下微调（能写实的方案章可加、概述/程序性章减），"
            "保持各章之和≈全书目标,并把每章目标字数写进子写手指令；写手尽量写足达标,把方法论/步骤/案例/"
            "指标/保障展开写实写透——但内容优先,严禁为凑字数堆套话/复读/注水（宁可略欠,绝不掺水）。")


def _deviation_items_block(read: dict) -> str:
    """技术/商务/资格分类全量条目（title/value/clause_ids/star），供偏离表子写手逐条落表——
    不动 slim_read 本身，这里另起一段附加给规划轮（spec322）。"""
    cats = []
    for c in (read.get("categories") or []):
        if c.get("key") not in _DEVIATION_CATEGORY_KEYS:
            continue
        items = [{"title": it.get("title"), "value": it.get("value"),
                  "clause_ids": it.get("clause_ids", []), "star": it.get("star", False)}
                 for it in c.get("items", [])]
        cats.append({"key": c.get("key"), "title": c.get("title"), "items": items})
    return (f"{DEVIATION_TABLE_GUIDE}\n"
            f"技术/商务/资格全量条目（供偏离表逐条落表，不得遗漏 ★/▲）：\n"
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


def _collect_chapters(files: dict | None) -> dict[str, str]:
    """从 deepagent 虚拟 FS 结果（v2：{path: {content,...}}，路径带前导斜杠）按前缀收稿。"""
    chapters: dict[str, str] = {}
    for path, data in (files or {}).items():
        norm = path if path.startswith("/") else f"/{path}"
        if not norm.startswith(_CHAPTER_PREFIX):
            continue
        cid = norm[len(_CHAPTER_PREFIX):].removesuffix(".html")
        # content 允许缺省（deepagents 自身也按可缺处理）；空稿跳过——全空最终触发 fail-loud
        content = data.get("content", "") if isinstance(data, dict) else str(data)
        content = strip_document_shell(strip_chat_wrapper(content))  # 收稿统一清洗：剥对话包装 + 文档壳（防样式泄漏/围栏入库）
        if content:
            chapters[cid] = content
    return chapters


def make_content_node(ctx):
    """deepagent 节点：主控规划（todos）→ 按章派子写手 → 虚拟 FS 收稿 → state['chapters']。
    上下文压缩用 deepagents 内建 summarization middleware（长标书防超窗）；
    虚拟 FS 是默认 StateBackend、不开 execute；一章未产出即失败（run failed 可重试）。"""
    async def content_node(state):
        model = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
        deep = create_deep_agent(
            model=model, tools=[], system_prompt=CONTENT_PLANNER_PROMPT,
            subagents=[{"name": "chapter_writer", "description": "写指定一章的标书正文 HTML",
                        "system_prompt": CHAPTER_WRITER_PROMPT}],
        )
        # 读标依据走 slim_read（与 outline/review 一致）：read result 已并入全文分句 doc_sections
        # 与逐条 source_quote（token 大头），原样 dumps 会把整份招标原文灌进规划轮直接顶穿上下文。
        # 参考资料段插在「读标依据」与「请逐章生成」指令之间（brief §5）；ref 为空则消息与未启用 RAG 逐字节一致。
        outline = state.get("outline") or {}
        # 选包时把读标收窄到该包(spec324 优化):slim_read/偏离表/构成都只喂该包数据,上下文大降。
        read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
        head = (f"提纲：\n{json.dumps(outline, ensure_ascii=False)}\n\n"
                f"读标依据：\n{json.dumps(slim_read(read), ensure_ascii=False)}")
        # 偏离表章节存在时附加【偏离表指引】+ 全量条目数据（spec322）；无偏离表章节则与今天逐字节一致。
        structure = read.get("required_structure") or []
        deviation = _deviation_items_block(read) if _has_deviation_chapters(outline, structure) else ""
        # 招标自带格式模板（响应函/证明/一览表等）：抠原文随规划轮下发，对应章沿用模板不得自创格式
        template = _template_block(read, outline)
        length_plan = _length_plan_block(state.get("run_input") or {}, outline, read.get("scoring") or [])  # spec330 目标字数（评分加权）
        ref = await _content_reference_block(ctx, state)
        mid_parts = [p for p in (length_plan, deviation, template, ref) if p]
        mid = ("\n\n".join(mid_parts) + "\n\n") if mid_parts else ""
        user = f"{head}\n\n{mid}请逐章生成正文，每章写入 chapters/<章id>.html。"
        user += package_scope(state.get("run_input"))  # 选包时追加范围约束（spec324）
        # 逐章进度:从 outline 取章 id→标题,写完一章推一条 chapter.progress(前端实时勾选)。
        chapters_meta = {c.get("id"): c.get("title", c.get("id"))
                         for c in outline.get("chapters", []) if c.get("id")}
        # recursion_limit 随章数动态放大:每章约需「规划+派子写手+写文件+收稿」多步,加上下文压缩中间件;
        # 固定 100 步在 17 章的多包件标必撞 GraphRecursionError(实测跑 23 分钟后中止)。按 15 步/章 + 60 基础,
        # 封顶 600 防失控。选包过滤(spec324)缩了章数时这里也随之更省。
        recursion_limit = min(600, max(100, len(chapters_meta) * 15 + 60))
        # UsageCallback 补记 token（deepagent 直驱模型，不经 make_agent_node 埋点）。
        res = await deep.ainvoke(
            {"messages": [HumanMessage(content=user)]},
            config={"recursion_limit": recursion_limit, "callbacks": [
                UsageCallback(ctx, "content"),
                ChapterProgressCallback(ctx, len(chapters_meta), chapters_meta)]})
        chapters = _collect_chapters(res.get("files"))
        if not chapters:
            raise RuntimeError("deepagent 未产出任何章节草稿（chapters/*.html）")
        return {"chapters": chapters}
    return content_node


async def _rewrite_reference_block(ctx, state: dict, old: str, instruction: str) -> str:
    """rewrite 是真逐章：query 用「原章前 N 字 + 改写指令」检索，命中拼进改写提示词（spec316 A2）。"""
    run_input = state.get("run_input") or {}
    if not await _rag_on(ctx, run_input):
        return ""
    query = f"{old[:_REWRITE_QUERY_CHARS]} {instruction}"
    return await rag_retrieve.build_reference_block(
        ctx.user_id, [query], _default_top_k(run_input), tender_thread_id=ctx.thread_id)


def _rewrite_msg(old: str, instruction: str, ref: str) -> str:
    if ref:
        return f"原章 HTML：\n{old}\n\n{ref}\n\n改写指令：{instruction}"
    return f"原章 HTML：\n{old}\n\n改写指令：{instruction}"


async def rewrite_chapter(ctx, chapter_id: str, instruction: str, state: dict) -> str:
    """单章改写（/content 右栏 AI 对话）：原章 HTML + 用户指令 → 新 HTML。走轻量 create_agent，不重规划全本。
    state 传工作流状态**值 dict**（如 `(await graph.aget_state(cfg)).values`），不是 StateSnapshot 本身。"""
    old = state.get("chapters", {}).get(chapter_id, "")
    ref = await _rewrite_reference_block(ctx, state, old, instruction)
    sub = build_create_agent(REWRITE_PROMPT, [], ctx)
    msg = _rewrite_msg(old, instruction, ref)
    out = await sub.ainvoke({"messages": [HumanMessage(content=msg)]})
    # 先剥对话包装（开场白/```围栏）再剥文档壳：提示词禁不住模型客套，确定性清洗兜底
    return strip_document_shell(strip_chat_wrapper(out["messages"][-1].content))
