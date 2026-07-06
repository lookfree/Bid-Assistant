from __future__ import annotations
import json
import re
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import slim_read, upload_artifact
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.prompts.present import PRESENT_SYSTEM_PROMPT
from agent.agents.bidding_agent.render.pptx import render_pptx


def _plain(html: str) -> str:
    """章节 HTML → 纯文本摘要输入：述标要点/口播稿不需要标签，token 减半。"""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def make_present_node(ctx):
    """graph 节点（两段式 §4.2.1）：读 chapters+read → 产 DeckSpec（LLM）→ render_pptx 确定性渲染
    → .pptx 落 MinIO → 写 state['deck'] / artifacts['pptx']；模型未提交即失败（可重试）。
    spec315a：duration/template 取自 state['run_input']（App 每 run 透传），非法值回默认。"""
    async def present_node(state):
        run_input = state.get("run_input") or {}
        duration = run_input.get("duration")
        duration = duration if duration in (10, 15, 20) else 15       # 对齐 DeckSpec.duration 档位
        template = run_input.get("template")
        template = template if template in ("blue", "tech", "gov") else None
        chapters = {cid: _plain(html) for cid, html in (state.get("chapters") or {}).items()}
        payload = {"chapters": chapters, "read": slim_read(state.get("read") or {}),
                   "duration": duration}
        user = f"标书与评分点：\n{json.dumps(payload, ensure_ascii=False)}\n时长 {duration} 分钟，请产 DeckSpec。"
        if template:
            user += f"\n客户指定模板：{template}（template 字段必须用它）。"
        deck = await run_submit_agent(
            ctx, PRESENT_SYSTEM_PROMPT, user,
            "submit_deck", DeckSpec, "提交述标 DeckSpec")
        if template:
            deck.template = template   # 客户指定优先：模型没照办也强制生效
        data = render_pptx(deck)   # 模板色取 deck.template
        key = await upload_artifact(
            ctx, "present.pptx", data,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        return {"deck": deck.model_dump(), "artifacts": {"pptx": key}}
    return present_node
