from __future__ import annotations
import asyncio
import json
import re
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import (
    slim_read, upload_artifact, fetch_master_bytes, filter_read_by_package, parse_bid_chapters, publish_phase,
)
from agent.agents.bidding_agent.schemas import DeckDraft, DeckSpec, Slide, SlideNotes
from agent.agents.bidding_agent.prompts.present import PRESENT_SKELETON_PROMPT, PRESENT_NOTES_PROMPT
from agent.agents.bidding_agent.render.pptx import render_pptx


def _plain(html: str) -> str:
    """章节 HTML → 纯文本摘要输入：述标要点/口播稿不需要标签，token 减半。"""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


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
            chapters_src = await asyncio.to_thread(parse_bid_chapters, bid_files)
            if not chapters_src:
                raise RuntimeError("上传的标书未能解析出任何正文（扫描件/图片版暂不支持），请上传可复制文字的 docx/pdf 后重试")
        chapters = {cid: _plain(html) for cid, html in chapters_src.items()}
        # 选包时读标收窄到该包（spec324，与 review/outline 一致）：述标只按该包评分点组织，不把别包的
        # 评分/要求混进 PPT。未选包（单包/缺省/review-kind 独立线程无 read）→ 原样，行为不变。
        read_state = filter_read_by_package(state.get("read") or {}, run_input)
        payload = {"chapters": chapters, "read": slim_read(read_state),
                   "duration": duration}
        user = f"标书与评分点：\n{json.dumps(payload, ensure_ascii=False)}\n时长 {duration} 分钟，请产 DeckDraft 骨架。"
        if template:
            user += f"\n客户指定模板：{template}（template 字段必须用它）。"
        await publish_phase(ctx, "述标·基于标书与评分点搭建 PPT 骨架")
        # 骨架 schema 的约束最多（页数/分隔页/版式多样性/图表可比性/单位一致），3 轮实测会耗尽，
        # 整步失败退款、用户什么都拿不到——比多跑两轮糟得多，故这一步单独放宽到 5 轮。
        draft = await run_submit_agent(
            ctx, PRESENT_SKELETON_PROMPT, user,
            "submit_deck_draft", DeckDraft, "提交述标骨架（不含口播稿）", attempts=5)
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
        return {"deck": deck.model_dump(), "artifacts": {"pptx": key}}
    return present_node
