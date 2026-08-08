from __future__ import annotations
import asyncio
import json
import logging
import re
import time
from typing import Any
from deepagents import create_deep_agent          # 全流程唯一 deepagent 节点（§4.5）
from agent.models.resilient import resilient_chat  # 正文绕过 create_agent，降级链要自己带
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import HumanMessage
from agent.models.usage import UsageCallback
from agent.telemetry.tool_recorder import ToolCallRecorder
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.nodes.common import (
    slim_read, package_scope, filter_read_by_package, protect_images, restore_images,
    strip_clause_ids,
)
from agent.agents.bidding_agent.prompts.categories import category_scope
from agent.agents.bidding_agent.prompts.content import (
    CONTENT_PLANNER_PROMPT, CHAPTER_WRITER_PROMPT, CHAPTER_DRAFT_PROMPT, REWRITE_PROMPT,
    DEVIATION_TABLE_GUIDE, TEMPLATE_GUIDE)
from agent.rag import retrieve as rag_retrieve
from agent.agents.bidding_agent.render.sanitize import strip_document_shell, strip_chat_wrapper, clean_internal_ids
from agent.runtime.channels import progress_stream

logger = logging.getLogger(__name__)


class ChapterProgressCallback(AsyncCallbackHandler):
    """逐章进度埋点:deepagent 每次 write_file 到 chapters/<id>.html 就往进度流推一条 chapter.progress
    事件(done/total + 已完成章 id),前端据此实时勾选「哪章写完、还剩几章」。best-effort,推送失败不影响生成。"""

    def __init__(self, ctx: Any, total: int, titles: dict[str, str]):
        self.ctx = ctx
        self.total = total
        self.titles = titles          # chapter_id → 标题(前端展示用)；键集合即提纲的合法章 id
        self.done: list[str] = []
        self.rewrites: dict[str, int] = {}   # chapter_id → 重写次数（首写不算）
        self.chapter_started = time.monotonic()   # 当前章起笔时刻（心跳显示"本章已 N 分"）

    async def _log_pg(self, event_type: str, data: dict, level: str = "info") -> None:
        """章节事件同步落 agent_event_log（best-effort）。Redis 进度流 24h 过期，2026-08-01 空转
        事故复盘时 PG 里只有一条 run.start——正文步跑了什么必须能事后查。"""
        recorder = getattr(self.ctx, "recorder", None)
        if recorder is None or not getattr(self.ctx, "run_id", None):
            return
        try:
            await asyncio.to_thread(
                recorder.log_event, self.ctx.run_id, getattr(self.ctx, "agent_type", "unknown"),
                event_type, node="content", level=level, data=data,
                thread_id=getattr(self.ctx, "thread_id", None))
        except Exception:  # noqa: BLE001 埋点 best-effort，绝不影响正文生成
            logger.warning("chapter event log failed", exc_info=True)

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
        if self.titles and cid not in self.titles:
            # 幽灵章：模型写了提纲里不存在的章 id（实测 2026-08-01：t6 重写混乱中造出 "t6-new"，
            # 前端横幅显示「已完成 16/15 章（刚写完「t6-new」）」）。不计数、不推前端，只记 warn 供排查；
            # 收稿侧 _collect_chapters 同样按提纲过滤——两道闸，任何一道漏了幽灵章都到不了交付。
            await self._log_pg("chapter.phantom", {"chapterId": cid}, level="warn")
            return
        if cid in self.done:
            # 同一章第二次被写入 = 模型在重写已完成的章。这是上下文压缩丢进度的信号（2026-08-01
            # 实测：5 次整章重写、计数 45 分钟不动，只能靠人肉对 token_usage 时间线才看出来）。
            # 只进 PG 不进 Redis——前端计数不能虚高。
            self.rewrites[cid] = self.rewrites.get(cid, 0) + 1
            await self._log_pg("chapter.rewrite", {"chapterId": cid, "title": self.titles.get(cid, cid),
                               "rewrite": self.rewrites[cid]}, level="warn")
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
        await self._log_pg("chapter.done", {"chapterId": cid, "title": self.titles.get(cid, cid),
                           "done": len(self.done), "total": self.total})
        self.chapter_started = time.monotonic()   # 下一章从现在起算

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
        for it in _iter_items(chapter.get("items", [])):  # 含小节:条款引用可能挂在第三层
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


def _chapter_budgets(chapters: list[dict], target: int, scoring: list[dict] | None) -> list[str]:
    """各章字数「建议」预算：优先按评分分值加权（分在哪字在哪）；无可用评分信号回退组级+子项权重。
    百字取整、单章下限 300，原章序输出。总量精确≈target,交主笔按各章实质内容量再微调。"""
    score_by_ch = _scores_per_chapter(chapters, scoring or [])
    budgets = (_scoring_weighted_budgets(chapters, target, score_by_ch)
               if sum(score_by_ch.values()) > 0 else _group_weighted_budgets(chapters, target))
    return [f"- {c.get('id')}「{c.get('title', '')}」目标约 {budgets.get(c.get('id'), 300)} 字" for c in chapters]


# 篇幅超写校准（2026-07-28 生产实测):写手对"目标 N 字"系统性超写 ~40%（目标 5.6 万,生成完成时
# 产出 ~7.9 万;完整校准记录见 apps/web/lib/page-estimate.ts 文件头)。下发的工作目标 = 用户目标 ÷
# 本系数,超写回弹后恰落在用户目标附近。注意（评审提示):1.4 是在旧"±20% 写足"提示词下量的,本次
# 同时把写手上限收紧到 +10%——若新提示词真管住超写会变成系统性偏欠,盯导出 pdf_pages 回报双向调。
# 运营可经 run_input.overshoot_calibration 覆盖（App 从 billing_configs 的
# generation.overshoot_calibration 读出下发),不必发版;本常量只是未配置时的默认。
_OVERSHOOT_CALIBRATION = 1.4


def _calibration(run_input: dict) -> float:
    """超写校准系数:运营配置（run_input 下发)优先,非法/缺省回落默认;夹在 [1.0, 3.0] 防手滑。"""
    try:
        v = float(run_input.get("overshoot_calibration") or _OVERSHOOT_CALIBRATION)
    except (TypeError, ValueError):
        return _OVERSHOOT_CALIBRATION
    return min(3.0, max(1.0, v))


def _length_plan_block(run_input: dict, outline: dict, scoring: list[dict] | None = None) -> str:
    """【篇幅规划】（spec330 方案3）：用户选了目标总字数 → 先按超写校准折成工作目标，再按评分分值
    加权给各章「建议」预算，随规划轮下发；主笔把工作目标视作硬目标。未配置返回空串（行为不变）。"""
    target = run_input.get("target_chars")
    chapters = outline.get("chapters") or []
    if not isinstance(target, int) or target <= 0 or not chapters:
        return ""
    work = max(1000, round(target / _calibration(run_input) / 100) * 100)
    lines = _chapter_budgets(chapters, work, scoring)
    return ("【篇幅规划】全书目标约 " + f"{work} 字（硬目标,超过 10% 视为不合格）。"
            "下列各章目标是**按招标评分分值加权的建议**（评分高的方案章多、概述/表单/报价章少）：\n"
            + "\n".join(lines)
            + "\n主笔：以此为起点,再结合各章**实质内容量**上下微调（能写实的方案章可加、概述/程序性章减），"
            "保持各章之和≈全书目标,并把每章目标字数写进子写手指令；写手以目标为准写实写透,"
            "超过一成必须精简——内容优先,严禁为凑字数堆套话/复读/注水（宁可略欠,绝不掺水）。")


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


def _deviation_items_block(read: dict) -> str:
    """技术/商务/资格分类全量条目（title/value/clause_ids/star），供偏离表子写手逐条落表——
    不动 slim_read 本身，这里另起一段附加给规划轮（spec322）。"""
    cats = []
    for c in (read.get("categories") or []):
        if c.get("key") not in _DEVIATION_CATEGORY_KEYS:
            continue
        # 不带 clause_ids：那是内部键，模型会照着提示词把它填进偏离表的"出处"列
        items = [{"title": it.get("title"), "value": it.get("value"), "star": it.get("star", False)}
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


def _collect_chapters(files: dict | None, allowed: set[str] | None = None) -> dict[str, str]:
    """从 deepagent 虚拟 FS 结果（v2：{path: {content,...}}，路径带前导斜杠）按前缀收稿。
    allowed=提纲章 id 集合：不在提纲里的幽灵章（模型混乱时自造 id，实测 "t6-new"）一律不收——
    上次没混进交付纯属模型后来自己覆盖了它，不过滤等于把交付质量押在运气上。"""
    chapters: dict[str, str] = {}
    dropped: list[str] = []
    for path, data in (files or {}).items():
        norm = path if path.startswith("/") else f"/{path}"
        if not norm.startswith(_CHAPTER_PREFIX):
            continue
        cid = norm[len(_CHAPTER_PREFIX):].removesuffix(".html")
        if allowed is not None and cid not in allowed:
            dropped.append(cid)
            continue
        # content 允许缺省（deepagents 自身也按可缺处理）；空稿跳过——全空最终触发 fail-loud
        content = data.get("content", "") if isinstance(data, dict) else str(data)
        # 收稿统一清洗：剥对话包装 + 文档壳（防样式泄漏/围栏入库），并抹掉内部条款 id——
        # 2026-08-08 线上实测正文里出现过 <td>sec-37-c36~c37</td>，等于交给评委的标书上
        # 印着我们的内部编号（喂给写手的读标结论里带 clause_ids，模型顺手抄进了正文）。
        content = clean_internal_ids(strip_document_shell(strip_chat_wrapper(content)))
        if content:
            chapters[cid] = content
    if dropped:
        logger.warning("collect_chapters dropped phantom ids: %s", dropped)
    return chapters


async def _log_incomplete(ctx, missing: list[str], total: int, phase: str) -> None:
    """漏章落 observability 事件。生产 root logger 是 WARNING 且日志会滚掉——
    「这次交付少了几章」必须查得到，否则复盘时只剩用户截图（与 length_telemetry 同款做法）。"""
    try:
        if ctx.recorder and ctx.run_id:
            await asyncio.to_thread(
                ctx.recorder.log_event,
                ctx.run_id, ctx.agent_type, "content_incomplete", node="content",
                data={"missing": missing, "missing_count": len(missing), "total": total, "phase": phase},
                thread_id=ctx.thread_id,
            )
    except Exception:  # noqa: BLE001 埋点失败绝不影响交付
        logger.warning("content incomplete event write failed", exc_info=True)


async def _fill_missing_chapters(ctx, deep, chapters: dict[str, str], meta: dict, limit: int, progress_cb) -> dict[str, str]:
    """漏写的章补一轮。

    2026-08-06 生产实例：20 章的标书写到第 14 章就停了（t6–t11 一个字没有），而
    `if not chapters` 只在**一章都没有**时才失败，于是整步标 done、照常扣费、照常进入
    审查与导出——审查报「缺章」，导出连挂 9 次，用户拿到的是半本标书却没收到任何提示。
    （那次的诱因是首个 write_todos 因参数类型被拒、计划清单没建起来，但补写不赌原因：
    不管模型为什么停，漏了就补。）

    只补漏的那几章，不重写已有的：已写好的是用户付过钱的成果，重跑一遍既费钱又可能变差。
    补完仍缺就如实记一条事件——此时不抛错，14 章成稿比"全额退款、从头再来"对用户更有价值，
    前端每章本就有「待生成」标记。
    """
    missing = [cid for cid in meta if cid not in chapters]
    if not missing:
        return chapters
    logger.warning("content 漏写 %d/%d 章，补写：%s", len(missing), len(meta), missing)
    await _log_incomplete(ctx, missing, len(meta), "before_retry")
    lines = "\n".join(f"- {cid}：{meta.get(cid)}" for cid in missing)
    msg = (f"还有 {len(missing)} 章没有写：\n{lines}\n"
           "请**只写这几章**，逐章写入 chapters/<章id>.html，不要改动已经写好的其它章节。")
    try:
        res = await deep.ainvoke(
            {"messages": [HumanMessage(content=msg)]},
            config={"recursion_limit": limit, "callbacks": [
                UsageCallback(ctx, "content"), progress_cb, ToolCallRecorder(ctx, "content")]})
        chapters = {**chapters, **_collect_chapters(res.get("files"), allowed=set(meta))}
    except Exception as e:  # 补写失败不能连累已成稿的章节
        logger.warning("content 补写失败（保留已成稿章节）：%s", e)
    still = [cid for cid in meta if cid not in chapters]
    if still:
        logger.error("content 补写后仍缺 %d 章：%s", len(still), still)
        await _log_incomplete(ctx, still, len(meta), "after_retry")
    return chapters


def _heartbeat_label(done: int, total: int, chapter_elapsed_s: float) -> str:
    """正文心跳文案：横幅每 5s 动一次，用户能看到"写到第几章、本章写了多久"。
    正文没有读标那种流式字数（deepagent 直驱模型非流式），能给的活信息就是章序 + 本章计时。"""
    n = min(done + 1, total)
    m, s = divmod(int(chapter_elapsed_s), 60)
    return f"正文·第 {n}/{total} 章成稿中（本章已 {m} 分 {s:02d} 秒）"


async def _chapter_heartbeat(ctx, cb: "ChapterProgressCallback", interval_s: float = 5.0) -> None:
    """正文步心跳泵：deepagent 单章一次长调用（大章 4~8 分钟），期间没有任何事件——
    横幅定格会被用户读成"卡住了"（实测反馈）。每 interval 推一条 heartbeat 直到被取消。"""
    from agent.runtime.progress import publish_event
    while True:
        await asyncio.sleep(interval_s)
        label = _heartbeat_label(len(cb.done), cb.total, time.monotonic() - cb.chapter_started)
        await publish_event(getattr(ctx, "redis", None), getattr(ctx, "run_id", None),
                            {"kind": "heartbeat", "label": label, "chars": 0})


def make_content_node(ctx):
    """deepagent 节点：主控规划（todos）→ 按章派子写手 → 虚拟 FS 收稿 → state['chapters']。
    上下文压缩用 deepagents 内建 summarization middleware（长标书防超窗）；
    虚拟 FS 是默认 StateBackend、不开 execute；一章未产出即失败（run failed 可重试）。"""
    async def content_node(state):
        # 带降级的模型：正文是全流程唯一不走 create_agent 的节点，也就绕过了 model_stream 那套
        # 降级链——生产实测近 10 天 content 成功 3 次/失败 25 次，其中 18 次是瞬断
        # （APIConnectionError），而连接类错误在其它步骤一次都没有。正文一跑十几二十分钟，
        # 跑到尾声被一次瞬断打掉全部作废，代价最大的一步反而最脆弱。
        model = resilient_chat(ctx.gateway, provider=None) if ctx.gateway else None
        # 分类落笔要点（spec334）**必须拼进子写手的 system_prompt**，不能只加在规划轮的用户消息里：
        # 真正落笔的是子写手，规划轮只是派活；靠它转述等于把要点的存亡押在模型愿不愿意复述上——
        # 提纲 desc 就是这么丢过的（CONTENT_PLANNER_PROMPT 里那句「必须原样转述」是事后补的）。
        cats = (state.get("run_input") or {}).get("bid_category")
        writer_prompt = CHAPTER_WRITER_PROMPT + category_scope(cats, "writing")
        deep = create_deep_agent(
            model=model, tools=[], system_prompt=CONTENT_PLANNER_PROMPT,
            subagents=[{"name": "chapter_writer", "description": "写指定一章的标书正文 HTML",
                        "system_prompt": writer_prompt}],
        )
        # 读标依据走 slim_read（与 outline/review 一致）：read result 已并入全文分句 doc_sections
        # 与逐条 source_quote（token 大头），原样 dumps 会把整份招标原文灌进规划轮直接顶穿上下文。
        # 参考资料段插在「读标依据」与「请逐章生成」指令之间（brief §5）；ref 为空则消息与未启用 RAG 逐字节一致。
        outline = state.get("outline") or {}
        # 选包时把读标收窄到该包(spec324 优化):slim_read/偏离表/构成都只喂该包数据,上下文大降。
        read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
        # **只在喂给模型的这条消息上剥内部条款 id**：id 是我们代码内部的连接键——
        # _template_block 靠它把招标原文的格式模板捞出来、_chapter_requirements 靠它取要求，
        # 前端靠它让用户点回原文，这些都照常用。模型需要的是它**指向的文本**，不是这个键：
        # 看得见就会写出来（2026-08-08 用户截图：偏离表整列印着 sec-19-c129…，那一列还正是
        # 提示词点名要的）。事后清洗只能把格子抹空，留个有表头没内容的列，更难看。
        head = (f"提纲：\n{json.dumps(strip_clause_ids(outline), ensure_ascii=False)}\n\n"
                f"读标依据：\n{json.dumps(strip_clause_ids(slim_read(read)), ensure_ascii=False)}")
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
        user += category_scope(cats, "planning")       # 章节层面的写作要点（spec334，只取主类别）
        # 逐章进度:从 outline 取章 id→标题,写完一章推一条 chapter.progress(前端实时勾选)。
        chapters_meta = {c.get("id"): c.get("title", c.get("id"))
                         for c in outline.get("chapters", []) if c.get("id")}
        # recursion_limit 随章数动态放大:每章约需「规划+派子写手+写文件+收稿」多步,加上下文压缩中间件;
        # 固定 100 步在 17 章的多包件标必撞 GraphRecursionError(实测跑 23 分钟后中止)。按 15 步/章 + 60 基础,
        # 封顶 600 防失控。选包过滤(spec324)缩了章数时这里也随之更省。
        recursion_limit = min(600, max(100, len(chapters_meta) * 15 + 60))
        # UsageCallback 补记 token（deepagent 直驱模型，不经 make_agent_node 埋点）。
        progress_cb = ChapterProgressCallback(ctx, len(chapters_meta), chapters_meta)
        hb = asyncio.create_task(_chapter_heartbeat(ctx, progress_cb))  # 横幅每 5s 动一次
        try:
            res = await deep.ainvoke(
                {"messages": [HumanMessage(content=user)]},
                config={"recursion_limit": recursion_limit, "callbacks": [
                    UsageCallback(ctx, "content"),
                    progress_cb,
                    ToolCallRecorder(ctx, "content")]})  # agent_tool_call 落库（此前全库 0 行）
        finally:
            hb.cancel()
        chapters = _collect_chapters(res.get("files"), allowed=set(chapters_meta))
        if not chapters:
            raise RuntimeError("deepagent 未产出任何章节草稿（chapters/*.html）")
        chapters = await _fill_missing_chapters(ctx, deep, chapters, chapters_meta, recursion_limit, progress_cb)
        await _log_length_telemetry(ctx, state.get("run_input") or {}, chapters)  # 超写系数的校准数据源（评审 F2）
        return {"chapters": chapters}
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


def _collect_clause_ids(nodes: list[dict] | None) -> set[str]:
    """递归收集提纲子树上的条款 id。

    提纲是五级（节→小节→细分→明细），**每一级都带 clause_ids**；只遍历两层会把四、五级
    的招标依据整片丢掉，而恰恰是拆得最细的那些节点才有明确条款。
    章本身没有 clause_ids 字段（见 schemas.OutlineChapter），所以只从 items 往下走。"""
    out: set[str] = set()
    for n in nodes or []:
        out |= set(n.get("clause_ids") or [])
        out |= _collect_clause_ids(n.get("children"))
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
    # 先剥对话包装（开场白/```围栏）再剥文档壳：提示词禁不住模型客套，确定性清洗兜底
    new = clean_internal_ids(strip_document_shell(strip_chat_wrapper(last.content)))
    return restore_images(new, kept_images)
