"""正文代码编排引擎（任务 #84）：编排权从 deepagent 拿回代码，像分段读标那样。

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
  · 每章只带自己的定位与要求（复用单章改写那套上下文构造）——不再整轮重发 5 万 token。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time

from langchain_core.messages import HumanMessage, SystemMessage

from agent.config import settings
from agent.models.resilient import resilient_chat
from agent.models.usage import UsageCallback
from agent.runtime.progress import publish_event

logger = logging.getLogger(__name__)

# 提示词/上下文构造一变，旧缓存整体作废（与分段读标同一手法）
_PROMPT_VER = "p1"
_CACHE_TTL_S = 24 * 3600
# 产出下限：短于此视为残章，重试一次；两次都残按缺章记，交给前端「补齐」按钮（免费）
_MIN_CHAPTER_CHARS = 120


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


class _Progress:
    """进度出口：与 deepagent 引擎同一事件形状，前端零改动。
    在代码编排下这些数字**不再靠回调猜**——写完就是写完，几路在写就是几路。"""

    def __init__(self, ctx, total: int, titles: dict[str, str]):
        self.ctx, self.total, self.titles = ctx, total, titles
        self.done: list[str] = []
        self.in_flight = 0
        self.batch_started = time.monotonic()

    async def chapter_done(self, cid: str) -> None:
        self.done.append(cid)
        ev = {"type": "progress", "data": {"kind": "chapter", "chapterId": cid,
              "title": self.titles.get(cid, cid), "done": len(self.done), "total": self.total,
              "doneIds": list(self.done)}}
        try:
            if self.ctx.redis and self.ctx.run_id:
                from agent.runtime.channels import progress_stream
                await asyncio.to_thread(self.ctx.redis.xadd, progress_stream(self.ctx.run_id),
                                        {"event": json.dumps(ev, ensure_ascii=False)})
        except Exception:  # noqa: BLE001 进度 best-effort
            logger.warning("chapter progress publish failed", exc_info=True)

    async def heartbeat(self, interval_s: float = 5.0) -> None:
        from agent.agents.bidding_agent.nodes.content import _heartbeat_label
        while True:
            await asyncio.sleep(interval_s)
            label = _heartbeat_label(len(self.done), self.total,
                                     time.monotonic() - self.batch_started, self.in_flight)
            await publish_event(getattr(self.ctx, "redis", None), getattr(self.ctx, "run_id", None),
                                {"kind": "heartbeat", "label": label, "chars": 0})


def _chapter_brief(state: dict, ch: dict, shared: dict) -> str:
    """单章写作简报：定位/小节/相邻章/★要求（复用改写那套） + 按需的偏离表数据/格式模板/篇幅规划。
    **只带本章相关的**：整轮重发全量上下文正是旧引擎 36:1 输入比的来源。"""
    from agent.agents.bidding_agent.nodes.content import (
        _DEVIATION_KEYWORD, _rewrite_context_block)

    parts = [_rewrite_context_block(state, ch.get("id") or "")]
    if shared.get("length_plan"):
        parts.append(shared["length_plan"])
    title = ch.get("title") or ""
    if shared.get("deviation") and _DEVIATION_KEYWORD in title:
        parts.append(shared["deviation"])          # 偏离表全量条目只发给偏离表章
    if shared.get("template") and (f"《{title}》" in shared["template"] or title in shared["template"]):
        parts.append(shared["template"])           # 招标格式模板只发给被点名的格式章
    if shared.get(f"ref:{ch.get('id')}"):
        parts.append(shared[f"ref:{ch.get('id')}"])
    parts.append(f"请撰写本章（{ch.get('no') or ''} {title}）的完整正文 HTML。")
    return "\n\n".join(p for p in parts if p)


async def _write_one(ctx, chat, system_prompt: str, state: dict, ch: dict, shared: dict,
                     sem: asyncio.Semaphore, progress: _Progress, generation: int) -> tuple[str, str]:
    """写一章：断点命中直接用；否则限流下调模型，产出清洗后落缓存。残章重试一次。"""
    from agent.agents.bidding_agent.render.sanitize import (
        clean_internal_ids, strip_chat_wrapper, strip_document_shell)

    cid = ch.get("id") or ""
    brief = _chapter_brief(state, ch, shared)
    key = _cache_key(ctx, generation, f"{system_prompt}\n--\n{brief}")
    cached = await _cache_get(ctx, key)
    if cached:
        logger.info("章 %s 断点命中，跳过模型调用", cid)
        await progress.chapter_done(cid)
        return cid, cached
    msgs = [SystemMessage(content=system_prompt), HumanMessage(content=brief)]
    cfg = {"callbacks": [UsageCallback(ctx, "content")]}
    html = ""
    for attempt in (1, 2):
        async with sem:
            progress.in_flight += 1
            if progress.in_flight == 1:
                progress.batch_started = time.monotonic()
            try:
                out = await chat.ainvoke(msgs, config=cfg)
            except Exception as e:  # noqa: BLE001 降级链都救不回来的才到这——记缺章，别连累别人
                logger.warning("章 %s 第 %d 次生成失败：%s", cid, attempt, str(e)[:120])
                continue
            finally:
                progress.in_flight -= 1
        html = clean_internal_ids(strip_document_shell(strip_chat_wrapper(out.content or "")))
        if len(html) >= _MIN_CHAPTER_CHARS and "<" in html:
            break
        logger.warning("章 %s 第 %d 次产出过短（%d 字符），重试", cid, attempt, len(html))
        msgs = [SystemMessage(content=system_prompt),
                HumanMessage(content=brief + "\n\n上次产出过短或为空，请完整撰写本章正文 HTML。")]
    if len(html) < _MIN_CHAPTER_CHARS or "<" not in html:
        logger.error("章 %s 两次尝试仍无有效产出，记为缺章", cid)
        return cid, ""
    await _cache_set(ctx, key, html)
    await progress.chapter_done(cid)
    return cid, html


async def run_content_pipeline(ctx, state: dict) -> dict[str, str]:
    """入口：提纲各章并发（限流）独立生成 → {章id: html}。缺章如实缺（前端有免费补齐）。"""
    from agent.agents.bidding_agent.nodes.common import filter_read_by_package
    from agent.agents.bidding_agent.nodes.content import (
        CHAPTER_DRAFT_PROMPT, _content_reference_block, _deviation_items_block,
        _has_deviation_chapters, _length_plan_block, _template_block)
    from agent.agents.bidding_agent.prompts.categories import category_scope

    outline = state.get("outline") or {}
    chapters = [c for c in outline.get("chapters", []) if c.get("id")]
    if not chapters:
        raise RuntimeError("提纲为空，无章可写")
    read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
    run_input = state.get("run_input") or {}
    generation = int(run_input.get("content_generation") or 0)

    cats = run_input.get("bid_category") or []
    system_prompt = CHAPTER_DRAFT_PROMPT + category_scope(cats, "writing")
    structure = read.get("required_structure") or []
    shared: dict = {
        "length_plan": _length_plan_block(run_input, outline, read.get("scoring") or []),
        "deviation": _deviation_items_block(read) if _has_deviation_chapters(outline, structure) else "",
        "template": _template_block(read, outline),
    }
    # RAG 参考资料整轮取一次（与旧引擎同口径），发给每章
    ref = await _content_reference_block(ctx, state)
    if ref:
        for c in chapters:
            shared[f"ref:{c['id']}"] = ref

    chat = resilient_chat(ctx.gateway, provider=None) if ctx.gateway else None
    sem = asyncio.Semaphore(max(1, int(getattr(settings, "model_content_max_parallel", 5))))
    titles = {c["id"]: c.get("title", c["id"]) for c in chapters}
    progress = _Progress(ctx, len(chapters), titles)
    hb = asyncio.create_task(progress.heartbeat())
    try:
        results = await asyncio.gather(*[
            _write_one(ctx, chat, system_prompt, state, c, shared, sem, progress, generation)
            for c in chapters])
    finally:
        hb.cancel()
        await asyncio.gather(hb, return_exceptions=True)
    out = {cid: html for cid, html in results if html}
    if not out:
        raise RuntimeError("deepagent 未产出任何章节草稿（chapters/*.html）")   # 沿用既有错误文案，App 侧同一处理
    missing = [cid for cid, html in results if not html]
    if missing:
        logger.error("代码编排收尾仍缺 %d 章：%s（前端可免费补齐）", len(missing), missing)
    return out
