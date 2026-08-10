from __future__ import annotations
import asyncio
import logging
import json
import re
from html import unescape
from agent.framework.budget import run_with_shrink
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import (
    slim_read, upload_artifact, fetch_master_bytes, filter_read_by_package, parse_bid_chapters, publish_phase,
    allocate_chapter_budget, chapters_budget, chapters_in_outline, compress_read,
    MIN_CHAPTER_CHARS,
    strip_inline_images,
)
from agent.agents.bidding_agent.schemas import DeckDraft, DeckSpec, Slide, SlideNotes
from agent.agents.bidding_agent.prompts.present import PRESENT_SKELETON_PROMPT, PRESENT_NOTES_PROMPT
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.agents.bidding_agent.render.preview import render_deck_previews

logger = logging.getLogger(__name__)


def _plain(html: str) -> str:
    """章节 HTML → 纯文本摘要输入：述标要点/口播稿不需要标签，token 减半。
    先剥内联图片——base64 单张二十万字符，不剥的话述标输入被一张图撑爆。

    剥完标签要 unescape：正文里的 <、>、& 在 HTML 里是以实体存的（线下标书由
    common._aggregate 转义写入，生成正文由模型/编辑器写入），不还原的话模型看到的是
    "响应时间&lt;30分钟"——实体既占额外字数，也让它读不出这是个数值区间。
    顺序不能反：先还原再剥标签，会把实体形式的尖括号变成真标签再被剥掉。
    unescape 放在压空白之前：&nbsp; 还原出来的是不间断空格，一并压掉。"""
    return re.sub(r"\s+", " ",
                  unescape(re.sub(r"<[^>]+>", " ", strip_inline_images(html)))).strip()


def _slide_notes_context(s) -> dict:
    """单页喂给口播稿段的上下文：bullets 之外，chart/comparison 版式必须把具体数字摊开给模型——
    否则它手里只有标题+评分点，写不出真实数字的讲稿（评委看到图表，讲稿却在打太极，图表页
    就白放了）。"""
    ctx: dict = {"id": s.id, "title": s.title, "scoring": s.scoring, "bullets": s.bullets, "layout": s.layout}
    if s.layout == "chart" and s.chart:
        ctx["chart_data"] = {
            "type": s.chart.type,
            "categories": s.chart.categories,
            "series": [{"name": ser.name, "values": ser.values} for ser in s.chart.series],
        }
    if s.stats:
        ctx["stats"] = [{"value": it.value, "label": it.label} for it in s.stats]
    return ctx


def _notes_user_msg(draft: DeckDraft, duration: int) -> str:
    """骨架页喂 id/title/scoring/bullets/layout（不含 qa/template），chart/comparison 版式
    额外带上具体数值，紧凑输入供口播稿段逐页写 notes。"""
    skeleton = [_slide_notes_context(s) for s in draft.slides]
    return (f"为以下每页幻灯片写口播稿。时长 {duration} 分钟。\n"
            f"{json.dumps(skeleton, ensure_ascii=False)}\n"
            "用 submit_slide_notes 一次性提交，notes 数组每项 {id, notes}，id 必须与输入页 id 一一对应。")


async def _upload_previews(ctx, pptx_bytes: bytes) -> list[str]:
    """把 .pptx 渲染成逐页 PNG 并落 MinIO，返回 key 列表（顺序即页序）。

    述标页据此显示**真实渲染图**，不再用另一套 CSS 近似——两套渲染器并存必然漂移，
    2026-08-07 拿客户产物比对，评分点位置/要点编号/页码/分隔线四处都不一致。

    **全程吞错**：渲染失败（soffice 缺失、超时、PDF 渲染异常）绝不能影响述标交付——
    PPT 本身已经生成好了，预览只是让人看得更准。失败时返回空列表，前端回落到原来的
    CSS 预览，用户至少还有得看。渲染在线程池里做：LibreOffice 是同步阻塞进程，
    直接在事件循环上跑会卡住同进程所有并发 run（本仓在 Redis/PG 同步调用上踩过同款）。
    """
    try:
        images = await asyncio.to_thread(render_deck_previews, pptx_bytes)
    except Exception:  # noqa: BLE001 预览是增强，绝不反噬交付
        logger.warning("述标预览图渲染失败，前端将回落到 CSS 预览", exc_info=True)
        return []
    keys: list[str] = []
    for i, png in enumerate(images, 1):
        try:
            keys.append(await upload_artifact(ctx, f"preview-{i:02d}.png", png, "image/png"))
        except Exception:  # noqa: BLE001 单页上传失败就整组放弃：半套图会让页码错位，比没有更糟
            logger.warning("预览图上传失败（第 %d 页），本次不提供预览图", i, exc_info=True)
            return []
    return keys


def _merge_deck(draft: DeckDraft, slide_notes: SlideNotes) -> DeckSpec:
    """按 slide id 合并骨架 + 口播稿；缺页 notes 兜底空串，不因个别页缺稿整体失败。"""
    note_map = {n.id: n.notes for n in slide_notes.notes}
    slides = [Slide(**d.model_dump(), notes=note_map.get(d.id, "")) for d in draft.slides]
    return DeckSpec(title=draft.title, duration=draft.duration, template=draft.template,
                     enterprise_template_id=draft.enterprise_template_id, slides=slides, qa=draft.qa)


def make_present_node(ctx):
    """graph 节点（两段式 §4.2.1，spec205.1 Fix2）：读 chapters+read → 先产骨架 DeckDraft（不含 notes）
    → 再逐页产口播稿 SlideNotes → 按 id 合并成 DeckSpec → render_pptx 确定性渲染 → .pptx 落 MinIO
    → 写 state['deck'] / artifacts['pptx']；模型未提交即失败（可重试）。骨架 JSON 去掉最大最易崩的
    notes 自由文本字段，单次提交体积更小更稳。
    spec315a：duration/template 取自 state['run_input']（App 每 run 透传），非法值回默认。
    企业母版：run_input['enterprise_template_key'] 若给出（App 侧按 enterprise_template_id 解析出的
    MinIO key），预取字节传给 render_pptx 套用客户自有 .pptx/.potx 主题/母版/logo；缺失或取不到、
    或母版本身渲染失败都会静默回退今天的空白设计，不影响述标产出。key 本身无条件写回
    deck.enterprise_template_id（与本轮母版是否取成功无关），export 重渲时按它重新取一次母版。
    独立述标（线下标书，与 review 节点同一 spec328 机制）：chapters 为空 + run_input.bid_file_key
    存在 → 确定性解析上传标书成章（无 LLM、不计费），述标不依赖是否跑过审查/是否有招标文件——
    用户想述标就述标；解析失败（扫描件/图片版）直接失败让 run 可重试，绝不拿空文档产假 PPT。"""
    async def present_node(state):
        run_input = state.get("run_input") or {}
        duration = run_input.get("duration")
        duration = duration if duration in (10, 15, 20) else 15       # 对齐 DeckSpec.duration 档位
        template = run_input.get("template")
        template = template if template in ("blue", "tech", "gov") else None
        enterprise_key = run_input.get("enterprise_template_key")
        master_bytes = await fetch_master_bytes(enterprise_key)
        chapters_src = state.get("chapters") or {}
        bid_files = run_input.get("bid_file_keys") or (
            [run_input["bid_file_key"]] if run_input.get("bid_file_key") else []
        )
        if not chapters_src and bid_files:
            # 述标**不做**扫描页 OCR（见 parse_bid_chapters）：证照/签字页对讲标 PPT 没有信息量，
            # 却要花掉整份文件的识别时间。所以这条文案在这里恒成立，不像审查那样随 OCR 配置分流。
            chapters_src = await asyncio.to_thread(parse_bid_chapters, bid_files)
            if not chapters_src:
                raise RuntimeError("上传的标书未能解析出任何正文（扫描件/图片版暂不支持），请上传可复制文字的 docx/pdf 后重试")
        # 述标此前**完全没有长度上限**，整本标书原样喂出去：2026-08-08 生产实测，26.5 万字符的
        # 正文让输入涨到 98305 tokens，加上后台配的 max_tokens=32768 超出 131072 的窗口，
        # 400 直接整步失败——大标书的述标是必炸而不是偶发。与审查同口径按剩余窗口注水分配。
        # 同审查：删章留下的孤儿键不该进 PPT
        filtered = chapters_in_outline(chapters_src, state.get("outline") or {})
        # 只拦"**被过滤清空**"这一种：本来就没有正文的场景（自查/空提纲）上面已有各自的处理，
        # 一刀切会把它们一起误杀。过滤清空 = 正文与提纲对不上，拿空文档跑计费步骤等于骗钱。
        if chapters_src and not filtered:
            raise RuntimeError("投标正文与提纲章节对不上（提纲可能已改动），请重新生成正文后再述标")
        chapters_src = filtered
        texts = {cid: _plain(html) for cid, html in chapters_src.items()}
        # 选包时读标收窄到该包（spec324，与 review/outline 一致）：述标只按该包评分点组织，不把别包的
        # 评分/要求混进 PPT。未选包（单包/缺省/review-kind 独立线程无 read）→ 原样，行为不变。
        read_state = filter_read_by_package(state.get("read") or {}, run_input)
        # 读标结论先压进额度的一半（与审查同一口径）：★条款与废标风险条一条不动。
        payload = {"chapters": {},                                  # 占位保住键序
                   "read": compress_read(slim_read(read_state), chapters_budget(ctx, "")),
                   "duration": duration}
        tail = f"\n客户指定模板：{template}（template 字段必须用它）。" if template else ""
        # 正文额度按剩余窗口算（与审查同一口径）：读标结论、系统提示、schema 先占，剩下的给正文。
        fixed = PRESENT_SKELETON_PROMPT + json.dumps(payload, ensure_ascii=False) + tail
        budget = chapters_budget(ctx, fixed)
        # 固定部分（读标结论 + 提示词 + schema）本身就撑满窗口：正文一个字都放不下。
        # 这种载荷缩多少轮都装不进去，与其白烧三轮 400，不如当场失败——App 侧全额退款。
        if budget < MIN_CHAPTER_CHARS:
            raise RuntimeError("招标文件的解析结果过大，超出模型可处理的长度；"
                               "请在「招标解读」页选择本次投标的包件后重试")
        await publish_phase(ctx, "述标·基于标书与评分点搭建 PPT 骨架")

        async def _attempt(factor: float):
            """按给定折扣重建载荷再跑——估算失准时由 run_with_shrink 逐档收缩。"""
            payload["chapters"] = allocate_chapter_budget(
                texts, int(budget * factor), MIN_CHAPTER_CHARS)
            user = (f"标书与评分点：\n{json.dumps(payload, ensure_ascii=False)}"
                    f"\n时长 {duration} 分钟，请产 DeckDraft 骨架。{tail}")
            # 骨架 schema 的约束最多（页数/分隔页/版式多样性/图表可比性/单位一致），3 轮实测会耗尽，
            # 整步失败退款、用户什么都拿不到——比多跑两轮糟得多，故这一步单独放宽到 5 轮。
            return await run_submit_agent(
                ctx, PRESENT_SKELETON_PROMPT, user,
                "submit_deck_draft", DeckDraft, "提交述标骨架（不含口播稿）", attempts=5)

        draft = await run_with_shrink(_attempt, label="述标骨架")
        await publish_phase(ctx, f"述标·逐页撰写口播稿（共{len(draft.slides)}页）")
        slide_notes = await run_submit_agent(
            ctx, PRESENT_NOTES_PROMPT, _notes_user_msg(draft, duration),
            "submit_slide_notes", SlideNotes, "提交每页口播稿")
        await publish_phase(ctx, "述标·渲染 PPT 文件")
        deck = _merge_deck(draft, slide_notes)
        # 兜底（schema 校验之外再守一道，与 SlideDraft._content_needs_substance 同一判据）：
        # 三种版式各自的"实质内容"形状不同，只看 bullets 会把 chart 版式（可以 0 bullets，
        # 数据本身就是内容）误判为空——原判据是 not any(bullets)，chart 页当合法证据用不了，
        # 逐页判断才不会漏判/误判。交付一份没内容的页面还扣 80 积分比失败更糟：
        # 直接抛错让 run 失败，App 侧全额退款可重试。
        def _lacks_substance(sl: Slide) -> bool:
            if sl.layout == "chart":
                return sl.chart is None
            if sl.layout == "comparison":
                return not any(b.strip() for b in sl.bullets) or not sl.stats
            return not any(b.strip() for b in sl.bullets)

        empty_titles = [sl.title for sl in deck.slides if sl.kind == "content" and _lacks_substance(sl)]
        if empty_titles:
            raise RuntimeError(f"述标骨架有页面没有实质内容（{'、'.join(empty_titles)}），已终止并退还积分，请重试")
        if template:
            deck.template = template   # 客户指定优先：模型没照办也强制生效
        if enterprise_key:
            deck.enterprise_template_id = enterprise_key   # 落库供 export 重渲时复用同一母版
        data = render_pptx(deck, master_bytes=master_bytes)   # 模板色取 deck.template
        key = await upload_artifact(
            ctx, "present.pptx", data,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        previews = await _upload_previews(ctx, data)
        # 本次渲染/上传失败：显式置空，且只置这一个键（与 export 的 pdf/pdf_pages 同款）。
        # state.artifacts 是跨 run 的 merge reducer——留空不写，reducer 会把上一版的 previews
        # 混进这次结果，用户看到的是旧一版的述标预览图，而不是"这次没有预览、回落 CSS"。
        return {"deck": deck.model_dump(),
                "artifacts": {"pptx": key, "previews": previews if previews else None}}
    return present_node
