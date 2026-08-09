"""正文代码编排引擎（任务 #84/#85/#86）：编排权从 deepagent 拿回代码，像分段读标那样。

2026-08-08 一个下午没能完整交付一份标书，全部事故同一个根：正文是全流程唯一把编排权
交给模型的一步——一个长命规划者揣着 5 万 token 连跑几十分钟，20 章清单全凭它的记忆。
上下文一压缩就失忆（b8 连写四遍 + 幽灵章）、write_todos 一拼坏就毒化历史（端点 400 循环）、
一波 15 路全派把端点打满（横幅十几分钟不动）、挂死一次全盘皆输（36 分钟白等）。

这里改成与分段读标同构的确定性流水线：
  · 章节清单来自提纲——代码拿在手里，**不可能忘**；
  · 每章一次独立模型调用（无工具、直出 HTML）——没有 write_todos/task，那两类故障整个消失；
  · 并发用 Semaphore（上限走配置）——不会再自己打满端点；
  · 每章写完即落 Redis 断点（键含提示词版本哈希，改提示词自动失效）——重试只补缺章；
  · 模型调用走 resilient_chat——流式空闲检测/总时长盖/降级链全套白送；
  · 每章简报**只带本章相关**且按章精确投递（偏离表/格式模板/篇幅目标）——不再整轮重发 5 万 token。

2026-08-08 晚评审补强（#86）：简报补齐深层提纲/desc/项目信息/红线/★全量要求（删规划者时
丢过的搬运职责）；截断稿与永久性错误分而治之；缓存键刻意排除检索段；坏数据只废一章不连累全局。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time

from langchain_core.messages import HumanMessage, SystemMessage
from openai import AuthenticationError

from agent.config import settings
from agent.models.gateway import ModelNotConfigured
from agent.models.resilient import resilient_chat
from agent.models.usage import UsageCallback
from agent.runtime.progress import publish_event

logger = logging.getLogger(__name__)

# 提示词/上下文构造一变，旧缓存整体作废（与分段读标同一手法）。p2：#86 简报补强。
_PROMPT_VER = "p2"
_CACHE_TTL_S = 24 * 3600
# 产出下限：短于此视为残章，重试一次；两次都残按缺章记，交给前端「补齐」按钮（免费）。
_MIN_CHAPTER_CHARS = 120
# 「（本项目不适用）」章的例外：写手规则明文要求正文只写一句——合规的 ~35 字不能被判残章
# 再逼着重写（评审 2026-08-08：两次"合规"后反被记缺章,白烧两次调用）。
_NA_MIN_CHARS = 10
# 本章招标要求行：★ **全量保留绝不截**；非★ 截断并如实注明。免费改写那套 12 条上限是
# 成本口径,付费首稿沿用等于静默丢弃第 13 条之后的所有要求含★（评审 2026-08-08）。
_REQ_NONSTAR_MAX = 48
_REQ_LINE_CHARS = 240

# 永久性错误：后台未配置模型 / 整条降级链鉴权失败。逐章重试 2N 次毫无意义,还把根因
# 埋进 warning——直接抛给整步,用户看到真实原因（评审 2026-08-08）。按类型识别,不猜文案。
_PERMANENT_ERRORS = (ModelNotConfigured, AuthenticationError)

# 人员/业绩定向注入（Task 3,2026-08-09 计划④）：章标题/子项 label 命中关键词即注入对应资料库
# 条目块——不再赌 RAG 召回率覆盖长尾。词表字面量按 Global Constraints,agent 侧独立判定。
_PERSONNEL_RE = re.compile(r"人员|团队|组织|配置|简历")
_PERFORMANCE_RE = re.compile(r"业绩|案例|经验|项目经历")
# 每类注入块字符预算：目标与偏离表条目预算（_DEVIATION_BLOCK_CHARS）一致——App 侧单条字段无
# 字符上限,这是唯一防线;但截断算法不同：偏离表逐条判断、超限就跳过非★条目继续凑其余条目,
# 这里逐条**顺序累计**、一超预算立即停止（含单条自身就超预算的情形,同样整体截断,不拆条目
# 内部字符）,并如实注明未列出条数（评审 2026-08-09）。
_LIBRARY_REF_BLOCK_CHARS = 3000


def _cache_key(ctx, generation: int, brief: str) -> str:
    digest = hashlib.sha256(brief.encode("utf-8")).hexdigest()[:16]
    return f"{settings.redis_prefix}chapter:{ctx.thread_id}:g{generation}:{_PROMPT_VER}:{digest}"


async def _cache_get(ctx, key: str) -> str | None:
    r = getattr(ctx, "redis", None)
    if not r:
        return None
    try:
        raw = await asyncio.to_thread(r.get, key)
        return raw.decode() if isinstance(raw, bytes) else raw
    except Exception:  # noqa: BLE001 缓存 best-effort，失败照常跑模型
        logger.warning("chapter cache get failed key=%s", key, exc_info=True)
        return None


async def _cache_set(ctx, key: str, html: str) -> None:
    r = getattr(ctx, "redis", None)
    if not r:
        return
    try:
        await asyncio.to_thread(r.set, key, html, ex=_CACHE_TTL_S)
    except Exception:  # noqa: BLE001
        logger.warning("chapter cache set failed key=%s", key, exc_info=True)


async def _log_pg(ctx, event_type: str, data: dict, level: str = "info") -> None:
    """章节事件落 agent_event_log（best-effort）：生产 root logger 是 WARNING 且日志会滚掉，
    「写完哪几章、最后缺了哪几章」必须查得到。落库走 to_thread（log_event 是同步 PG 写）。"""
    recorder = getattr(ctx, "recorder", None)
    if recorder is None or not getattr(ctx, "run_id", None):
        return
    try:
        await asyncio.to_thread(
            recorder.log_event, ctx.run_id, getattr(ctx, "agent_type", "bidding_agent"),
            event_type, node="content", level=level, data=data,
            thread_id=getattr(ctx, "thread_id", None))
    except Exception:  # noqa: BLE001 埋点 best-effort，绝不影响正文生成
        logger.warning("chapter event log failed", exc_info=True)


class _Progress:
    """进度出口：与旧引擎同一事件形状，前端零改动。
    在代码编排下这些数字**不再靠回调猜**——写完就是写完，几路在写就是几路。"""

    def __init__(self, ctx, total: int, titles: dict[str, str]):
        self.ctx, self.total, self.titles = ctx, total, titles
        self.done: list[str] = []
        self.in_flight = 0
        self.batch_started = time.monotonic()

    async def chapter_done(self, cid: str) -> None:
        self.done.append(cid)
        count = len(self.done)   # 快照：两个 await 之间并发完成会把计数读串（评审 2026-08-08）
        # 心跳计时口径=距上一章收稿：满载时 in_flight 的 0→1 永不再现,只在这里归零
        # 才不会显示"本批已 37 分"被读成卡死（评审 2026-08-08,当晚用户问过的正是这个）。
        self.batch_started = time.monotonic()
        ev = {"type": "progress", "data": {"kind": "chapter", "chapterId": cid,
              "title": self.titles.get(cid, cid), "done": count, "total": self.total,
              "doneIds": list(self.done)}}
        try:
            if self.ctx.redis and self.ctx.run_id:
                from agent.runtime.channels import progress_stream
                await asyncio.to_thread(self.ctx.redis.xadd, progress_stream(self.ctx.run_id),
                                        {"event": json.dumps(ev, ensure_ascii=False)},
                                        maxlen=1000, approximate=True)  # 与 publish_event 同款裁剪
        except Exception:  # noqa: BLE001 进度 best-effort
            logger.warning("chapter progress publish failed", exc_info=True)
        # 同步落 agent_event_log：Redis 进度流 24h 过期，正文步跑了什么必须能事后查
        # （2026-08-01 空转事故复盘时 PG 里只有一条 run.start——这条审计线不能丢）。
        await _log_pg(self.ctx, "chapter.done", {"chapterId": cid, "title": self.titles.get(cid, cid),
                      "done": count, "total": self.total})

    async def heartbeat(self, interval_s: float = 5.0) -> None:
        from agent.agents.bidding_agent.nodes.content import _heartbeat_label
        while True:
            await asyncio.sleep(interval_s)
            label = _heartbeat_label(len(self.done), self.total,
                                     time.monotonic() - self.batch_started, self.in_flight)
            await publish_event(getattr(self.ctx, "redis", None), getattr(self.ctx, "run_id", None),
                                {"kind": "heartbeat", "label": label, "chars": 0})


def _subtree_lines(items: object, depth: int = 0) -> list[str]:
    """本章子项整棵子树 → 逐级缩进行（含各级 desc）。提纲最深五级,**每一级都要到写手手里**：
    删规划者时丢过一版只给顶层 label——"页面拆到四级、成品只有两级"事故的复发通道（评审）。
    类型钳制+深度封顶：items 内部 API 层零校验,脏数据不炸付费步。"""
    out: list[str] = []
    if depth > 4 or not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()
        if label:
            line = "  " * depth + f"- {label}"
            d = it.get("desc")
            if isinstance(d, str) and d.strip():
                line += f"（本节写作要求：{d.strip()}）"
            out.append(line)
        out.extend(_subtree_lines(it.get("children"), depth + 1))
    return out


def _requirements_lines(read: dict, clause_ids: set[str]) -> list[str]:
    """本章须响应的招标要求：★ 全量在前绝不截,非★ 截断并注明条数。"""
    if not clause_ids:
        return []
    hits: list[tuple[bool, str]] = []
    for cat in read.get("categories") or []:
        for it in cat.get("items") or []:
            if not (set(it.get("clause_ids") or []) & clause_ids):
                continue
            star = bool(it.get("star"))
            value = (it.get("value") or "").strip()
            text = f"{'★ ' if star else ''}{(it.get('title') or '').strip()}{'：' + value if value else ''}"
            hits.append((star, text[:_REQ_LINE_CHARS]))
    stars = [t for s, t in hits if s]
    rest = [t for s, t in hits if not s]
    lines = [f"- {t}" for t in stars + rest[:_REQ_NONSTAR_MAX]]
    if len(rest) > _REQ_NONSTAR_MAX:
        lines.append(f"-（另有 {len(rest) - _REQ_NONSTAR_MAX} 条普通要求未逐条列出；★ 已全量列出）")
    return lines


def _pipeline_context(state: dict, ch: dict) -> str:
    """本章写作上下文（付费首稿口径，区别于免费改写 _rewrite_context_block 的瘦身版）：
    定位 / 章 desc / 整棵子项子树 / 相邻章 / 招标要求（★ 全量）。选包时读标先按包过滤。"""
    from agent.agents.bidding_agent.nodes.common import filter_read_by_package
    from agent.agents.bidding_agent.nodes.content import _collect_clause_ids

    outline = state.get("outline") or {}
    chapters = outline.get("chapters") or []
    idx = next((i for i, c in enumerate(chapters) if c.get("id") == ch.get("id")), -1)
    parts = [f"【本章定位】{ch.get('no') or ''} {ch.get('title') or ''}".strip()]
    desc = ch.get("desc")
    if isinstance(desc, str) and desc.strip():
        parts.append(f"本章写作说明（用户填写，须遵循）：{desc.strip()}")
    tree = _subtree_lines(ch.get("items"))
    if tree:
        parts.append("本章结构（逐级对应 <h3>/<h4>/<h5>/<h6>，标题用原文；带写作要求的按其要求写）：\n"
                     + "\n".join(tree))
    if idx >= 0:
        neigh = [chapters[i].get("title") or "" for i in (idx - 1, idx + 1) if 0 <= i < len(chapters)]
        if any(neigh):
            parts.append("相邻章节（内容不要与它们重复）：" + "、".join(n for n in neigh if n))
    read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
    reqs = _requirements_lines(read, _collect_clause_ids(ch.get("items")))
    if reqs:
        parts.append("本章须响应的招标要求（★ 为不可偏离）：\n" + "\n".join(reqs))
    return "\n".join(parts)


def _library_ref_line(it: dict) -> str:
    """单条人员/业绩资料库条目 → 简报行：`title|meta|label:value;…|body`（格式按计划 Task 3）。"""
    title = str(it.get("title") or "").strip()
    meta = str(it.get("meta") or "").strip()
    fields = ";".join(f"{f.get('label', '')}:{f.get('value', '')}"
                       for f in (it.get("fields") or []) if isinstance(f, dict))
    body = str(it.get("body") or "").strip()
    return f"- {title}|{meta}|{fields}|{body}"


def _library_ref_block(items: list, label: str) -> str:
    """人员/业绩资料库条目 → 简报文本块。条目数无字符上限（App 侧只按数量截前 20 条），
    这里是唯一的字符防线：累计逐条拼接,一超 `_LIBRARY_REF_BLOCK_CHARS` 立即停并如实注明
    未列出条数——宁可少列,不放任一次调用被顶穿。零条目返回空串（无 library_refs 时逐字节不变）。"""
    if not items:
        return ""
    header = f"【资料库·{label}】(供本章化用,不得整段照抄):"
    lines = [_library_ref_line(it) for it in items if isinstance(it, dict)]
    kept: list[str] = []
    dropped = 0
    for i, line in enumerate(lines):
        candidate = header + "\n" + "\n".join(kept + [line])
        if len(candidate) > _LIBRARY_REF_BLOCK_CHARS:
            dropped = len(lines) - i
            break
        kept.append(line)
    block = header + "\n" + "\n".join(kept)
    if dropped:
        block += f"\n(另有 {dropped} 条未列出)"
    return block


def _chapter_keyword_text(ch: dict) -> str:
    """章标题 + 各级子项 label 拼串，仅供人员/业绩关键词命中判定用（不含 desc/正文）——
    深度封顶+类型钳制与 `_subtree_lines` 同手法，脏 items 不炸命中判定。"""
    def _labels(items: object, depth: int = 0) -> list[str]:
        out: list[str] = []
        if depth > 4 or not isinstance(items, list):
            return out
        for it in items:
            if not isinstance(it, dict):
                continue
            label = str(it.get("label") or "").strip()
            if label:
                out.append(label)
            out.extend(_labels(it.get("children"), depth + 1))
        return out
    return " ".join([str(ch.get("title") or "")] + _labels(ch.get("items")))


def _chapter_brief(state: dict, ch: dict, shared: dict) -> tuple[str, str]:
    """单章简报 → (稳定部分, 检索段)。**缓存键只盖稳定部分**：检索段每次跑都可能不一样
    （资料库更新/召回抖动），进哈希会让"重试只补缺章"静默退化成全量重跑——旧引擎的
    resume 哈希刻意排除过它,这个不变量删旧路时丢了（评审 2026-08-08）。
    偏离表/格式模板/篇幅目标都**按章 id 精确投递**,不再靠标题子串猜。"""
    cid = ch.get("id") or ""
    parts = [_pipeline_context(state, ch)]
    if shared.get("project"):
        parts.append(shared["project"])
    budgets = shared.get("budgets") or {}
    if cid in budgets:
        parts.append(f"【篇幅】本章目标约 {budgets[cid]} 字（硬约束,上限 +10%,表格/表单文字计入；"
                     f"全书目标约 {shared.get('work_total')} 字——严禁凑字数注水,宁可略欠）。")
    if shared.get("risk"):
        parts.append(shared["risk"])
    if shared.get("deviation") and cid in (shared.get("deviation_ids") or set()):
        parts.append(shared["deviation"])          # 偏离表条目只发给偏离表章（按 id,含 structure_ref 识别的）
    tpl = (shared.get("templates") or {}).get(cid)
    if tpl:
        parts.append(tpl)                          # 招标格式模板只发给它自己的那一章
    # 人员/业绩定向注入（Task 3）：进 stable 部分而非检索段——库存变化即让命中章缓存键跟着
    # 变、无关章不受影响，语义与偏离表/模板一致（评审 2026-08-09）。
    text = _chapter_keyword_text(ch)
    if shared.get("personnel") and _PERSONNEL_RE.search(text):
        parts.append(shared["personnel"])
    if shared.get("performance") and _PERFORMANCE_RE.search(text):
        parts.append(shared["performance"])
    parts.append(f"请撰写本章（{ch.get('no') or ''} {ch.get('title') or ''}）的完整正文 HTML。")
    return "\n\n".join(p for p in parts if p), shared.get("ref") or ""


def _text_of(out) -> str:
    """模型输出正文。思考模式下 content 可能是内容块列表——直接当 str 会把 dict repr 当正文。"""
    c = getattr(out, "content", "")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in c)
    return str(c or "")


def _finish_reason(out) -> str | None:
    return (getattr(out, "response_metadata", None) or {}).get("finish_reason")


async def _attempt(ctx, chat, msgs: list, sem: asyncio.Semaphore, progress: _Progress):
    """单次模型调用（限流+进度计数）。返回模型输出;永久性错误向上抛,其余抛给调用方按次记失败。"""
    cfg = {"callbacks": [UsageCallback(ctx, "content")]}
    async with sem:
        progress.in_flight += 1
        try:
            return await chat.ainvoke(msgs, config=cfg)
        finally:
            progress.in_flight -= 1


async def _write_one(ctx, chat, system_prompt: str, state: dict, ch: dict, shared: dict,
                     sem: asyncio.Semaphore, progress: _Progress, generation: int) -> tuple[str, str]:
    """写一章：断点命中直接用；否则限流下调模型，产出清洗后落缓存。
    残章/截断稿重试一次（截断稿绝不入库——半章缓存 24h 等于把残稿钉死,评审 2026-08-08）；
    两次失败 → 记缺章。简报构造/清洗抛错只废本章,绝不连累其他 19 章（gather 无隔离,评审）。"""
    from agent.agents.bidding_agent.render.sanitize import (
        clean_internal_ids, strip_chat_wrapper, strip_document_shell)

    cid = ch.get("id") or ""
    try:
        stable, ref = _chapter_brief(state, ch, shared)
    except Exception:  # noqa: BLE001 脏提纲数据只废本章
        logger.exception("章 %s 简报构造失败，记缺章", cid)
        return cid, ""
    key = _cache_key(ctx, generation, f"{system_prompt}\n--\n{stable}")
    cached = await _cache_get(ctx, key)
    if cached:
        logger.info("章 %s 断点命中，跳过模型调用", cid)
        await progress.chapter_done(cid)
        return cid, cached
    user = stable + (f"\n\n{ref}" if ref else "")
    msgs = [SystemMessage(content=system_prompt), HumanMessage(content=user)]
    min_chars = _NA_MIN_CHARS if "不适用" in (ch.get("title") or "") else _MIN_CHAPTER_CHARS
    html = ""
    for attempt in (1, 2):
        try:
            out = await _attempt(ctx, chat, msgs, sem, progress)
        except _PERMANENT_ERRORS:
            raise                    # 配置/鉴权类：整步失败并带出根因,逐章重试毫无意义
        except Exception as e:  # noqa: BLE001 降级链都救不回来的瞬时失败：记一次,重试
            logger.warning("章 %s 第 %d 次生成失败：%s", cid, attempt, str(e)[:200])
            continue
        if _finish_reason(out) == "length":
            logger.warning("章 %s 第 %d 次输出被长度上限截断，重试（截断稿不入库）", cid, attempt)
            msgs = [SystemMessage(content=system_prompt),
                    HumanMessage(content=user + "\n\n上次输出因超长被截断：请压缩篇幅、确保本章完整收尾。")]
            html = ""
            continue
        try:
            html = clean_internal_ids(strip_document_shell(strip_chat_wrapper(_text_of(out))))
        except Exception:  # noqa: BLE001 清洗抛错按残章处理
            logger.exception("章 %s 产出清洗失败", cid)
            html = ""
        if len(html) >= min_chars and "<" in html:
            break
        logger.warning("章 %s 第 %d 次产出过短（%d 字符），重试", cid, attempt, len(html))
        msgs = [SystemMessage(content=system_prompt),
                HumanMessage(content=user + "\n\n上次产出过短或为空，请完整撰写本章正文 HTML。")]
    if len(html) < min_chars or "<" not in html:
        logger.error("章 %s 两次尝试仍无有效产出，记为缺章", cid)
        return cid, ""
    await _cache_set(ctx, key, html)
    await progress.chapter_done(cid)
    return cid, html


def _shared_blocks(state: dict, read: dict, outline: dict, chapters: list[dict]) -> dict:
    """整轮共享的简报素材（构建一次,按章精确投递）。全部先剥内部条款 id 再出门。"""
    from agent.agents.bidding_agent.nodes.common import strip_clause_ids
    from agent.agents.bidding_agent.nodes.content import (
        _DEVIATION_KEYWORD, _chapter_budget_map, _deviation_items_block,
        _deviation_structure_ids, _template_entries)

    structure = read.get("required_structure") or []
    dev_secs = _deviation_structure_ids(structure)
    # 偏离表章识别与数据投递用**同一个**判定（标题 或 structure_ref）——旧版造数据认两条、
    # 发数据只认标题,靠 structure_ref 标记的偏离章拿到零条目（评审 2026-08-08）。
    dev_ids = {c.get("id") for c in chapters
               if _DEVIATION_KEYWORD in (c.get("title") or "") or c.get("structure_ref") in dev_secs}
    budgets, work = _chapter_budget_map(state.get("run_input") or {}, outline, read.get("scoring") or [])
    meta = read.get("project_meta") or {}
    risks = strip_clause_ids({"items": read.get("risk_summary") or []})["items"]
    risk_txt = json.dumps(risks, ensure_ascii=False) if risks else ""
    # library_refs（Task 3）：App content 步下发，两类都空则键缺省——`or {}` 兜底后 .get 拿到 []，
    # `_library_ref_block` 对空列表返回空串，无 library_refs 的老行为逐字节不变。
    refs = (state.get("run_input") or {}).get("library_refs") or {}
    return {
        "project": ("【项目信息】（响应函/表单/落款字段据此填写，未知处留（待补充：____））："
                    + json.dumps(strip_clause_ids(meta), ensure_ascii=False)[:2000]) if meta else "",
        "risk": ("【读标红线】（涉及本章内容时不得违背）："
                 + (risk_txt[:3000] + "…（截断）" if len(risk_txt) > 3000 else risk_txt)) if risk_txt else "",
        "deviation": _deviation_items_block(read) if dev_ids else "",
        "deviation_ids": dev_ids,
        "templates": _template_entries(read, outline),
        "personnel": _library_ref_block(refs.get("personnel") or [], "人员"),
        "performance": _library_ref_block(refs.get("performance") or [], "业绩"),
        "budgets": budgets, "work_total": work,
    }


async def run_content_pipeline(ctx, state: dict) -> dict[str, str]:
    """入口：提纲各章并发（限流）独立生成 → {章id: html}。缺章如实缺（前端有免费补齐）。"""
    from agent.agents.bidding_agent.nodes.cert_placement import place_certificates
    from agent.agents.bidding_agent.nodes.common import filter_read_by_package
    from agent.agents.bidding_agent.nodes.content import CHAPTER_DRAFT_PROMPT, _content_reference_block
    from agent.agents.bidding_agent.nodes.credentials_chapter import SYS_CREDS_ID
    from agent.agents.bidding_agent.prompts.categories import category_scope

    outline_raw = state.get("outline") or {}
    # 系统章（如 sys-creds）结构性跳过（评审 2026-08-09 实证）：App 侧 state_overrides 每次触发
    # content 都会把库里 outline result 回灌进图内状态，outline 带着系统章是常态而非重试专属
    # 的边角场景——净化一次、往下游一路传净化后的 outline/state，不发模型调用、不进进度计数、
    # 不分字数预算、不进偏离表判定，比在每个消费点各自补一次 system 判断更不容易漏。
    # 纵深兜底（终审 C1）：web 侧曾把提纲白名单序列化时漏透传 "system" 键（sourceFileId 同类
    # 教训第三次）——就算这个键丢了，id 命中 SYS_CREDS_ID 仍按系统章处理，不靠单一信号。
    chapters = [c for c in outline_raw.get("chapters", [])
                if c.get("id") and not (c.get("system") or c.get("id") == SYS_CREDS_ID)]
    if not chapters:
        raise RuntimeError("提纲为空，无章可写")
    outline = {**outline_raw, "chapters": chapters}
    state = {**state, "outline": outline}
    read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
    run_input = state.get("run_input") or {}
    generation = int(run_input.get("content_generation") or 0)

    cats = run_input.get("bid_category") or []
    # planning 用途的分类知识原挂在规划轮——规划者删除后并入落笔 system（否则零调用方,评审）
    system_prompt = CHAPTER_DRAFT_PROMPT + category_scope(cats, "writing") + category_scope(cats, "planning")
    shared = _shared_blocks(state, read, outline, chapters)
    # RAG 参考资料整轮取一次发给每章；作为易变段**不进缓存键**（见 _chapter_brief）
    shared["ref"] = await _content_reference_block(ctx, state) or ""

    chat = resilient_chat(ctx.gateway, provider=None) if ctx.gateway else None
    sem = asyncio.Semaphore(max(1, int(getattr(settings, "model_content_max_parallel", 5))))
    titles = {c["id"]: c.get("title", c["id"]) for c in chapters}
    progress = _Progress(ctx, len(chapters), titles)
    hb = asyncio.create_task(progress.heartbeat())
    try:
        results = await asyncio.gather(*[
            _write_one(ctx, chat, system_prompt, state, c, shared, sem, progress, generation)
            for c in chapters], return_exceptions=True)
    finally:
        hb.cancel()
        await asyncio.gather(hb, return_exceptions=True)
    fatal = next((r for r in results if isinstance(r, BaseException)), None)
    if fatal is not None:
        raise fatal                  # 永久性错误：带根因整步失败（失败步自动退款）
    pairs = [r for r in results if isinstance(r, tuple)]
    out = {cid: html for cid, html in pairs if html}
    if not out:
        raise RuntimeError("未产出任何章节草稿（全部章节生成失败）")
    # 证照定向插章 post-pass（Task 4,计划③）：在缓存读写之外单独跑——fresh 章刚写完、
    # 缓存命中章刚取出，此刻统一现算一遍插图，绝不写回上面的章节缓存（评审 2026-08-09）。
    out = place_certificates(out, state)
    missing = [cid for cid, html in pairs if not html]
    if missing:
        logger.error("代码编排收尾仍缺 %d 章：%s（前端可免费补齐）", len(missing), missing)
        # 漏章落 observability 事件（与旧引擎同一事件名，复盘查询口径不变）
        await _log_pg(ctx, "content_incomplete", {"missing": missing, "missing_count": len(missing),
                      "total": len(chapters), "phase": "final"}, level="warn")
    return out
