from __future__ import annotations
import json
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import slim_read
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.prompts.present import PRESENT_SYSTEM_PROMPT
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.parsing.storage_read import storage      # spec106 的 MinIO 单例（读写同一封装）


def make_present_node(ctx, *, duration: int = 15):
    """graph 节点（两段式 §4.2.1）：读 chapters+read → 产 DeckSpec（LLM）→ render_pptx 确定性渲染
    → .pptx 落 MinIO → 写 state['deck'] / artifacts['pptx']；模型未提交即失败（可重试）。"""
    async def present_node(state):
        payload = {"chapters": state.get("chapters") or {}, "read": slim_read(state.get("read") or {}),
                   "duration": duration}
        user = f"标书与评分点：\n{json.dumps(payload, ensure_ascii=False)}\n时长 {duration} 分钟，请产 DeckSpec。"
        deck = await run_submit_agent(
            ctx, PRESENT_SYSTEM_PROMPT, user,
            "submit_deck", DeckSpec, "提交述标 DeckSpec")
        data = render_pptx(deck, template=deck.template)
        key = f"artifacts/{ctx.thread_id}/present.pptx"
        await storage.put_bytes(
            key, data,
            content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation")
        return {"deck": deck.model_dump(), "artifacts": {"pptx": key}}
    return present_node
