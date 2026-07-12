from __future__ import annotations
import json
import re
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import slim_read, upload_artifact, fetch_master_bytes, publish_phase
from agent.agents.bidding_agent.schemas import DeckDraft, DeckSpec, Slide, SlideNotes
from agent.agents.bidding_agent.prompts.present import PRESENT_SKELETON_PROMPT, PRESENT_NOTES_PROMPT
from agent.agents.bidding_agent.render.pptx import render_pptx


def _plain(html: str) -> str:
    """章节 HTML → 纯文本摘要输入：述标要点/口播稿不需要标签，token 减半。"""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def _notes_user_msg(draft: DeckDraft, duration: int) -> str:
    """骨架页只喂 id/title/scoring/bullets（不含 qa/template），紧凑输入供口播稿段逐页写 notes。"""
    skeleton = [{"id": s.id, "title": s.title, "scoring": s.scoring, "bullets": s.bullets}
                for s in draft.slides]
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
    deck.enterprise_template_id（与本轮母版是否取成功无关），export 重渲时按它重新取一次母版。"""
    async def present_node(state):
        run_input = state.get("run_input") or {}
        duration = run_input.get("duration")
        duration = duration if duration in (10, 15, 20) else 15       # 对齐 DeckSpec.duration 档位
        template = run_input.get("template")
        template = template if template in ("blue", "tech", "gov") else None
        enterprise_key = run_input.get("enterprise_template_key")
        master_bytes = await fetch_master_bytes(enterprise_key)
        chapters = {cid: _plain(html) for cid, html in (state.get("chapters") or {}).items()}
        payload = {"chapters": chapters, "read": slim_read(state.get("read") or {}),
                   "duration": duration}
        user = f"标书与评分点：\n{json.dumps(payload, ensure_ascii=False)}\n时长 {duration} 分钟，请产 DeckDraft 骨架。"
        if template:
            user += f"\n客户指定模板：{template}（template 字段必须用它）。"
        await publish_phase(ctx, "述标·基于标书与评分点搭建 PPT 骨架")
        draft = await run_submit_agent(
            ctx, PRESENT_SKELETON_PROMPT, user,
            "submit_deck_draft", DeckDraft, "提交述标骨架（不含口播稿）")
        await publish_phase(ctx, f"述标·逐页撰写口播稿（共{len(draft.slides)}页）")
        slide_notes = await run_submit_agent(
            ctx, PRESENT_NOTES_PROMPT, _notes_user_msg(draft, duration),
            "submit_slide_notes", SlideNotes, "提交每页口播稿")
        await publish_phase(ctx, "述标·渲染 PPT 文件")
        deck = _merge_deck(draft, slide_notes)
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
