from __future__ import annotations
from agent.agents.bidding_agent.render.docx import render_docx
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.nodes.common import upload_artifact


def make_export_node(ctx):
    """graph 节点：读 outline+chapters → 渲染完整标书 .docx → 落 MinIO → 写 artifacts['docx']。
    普通服务节点：确定性、无 LLM、不碰钱。与 present 的 pptx 由 state.artifacts 合并 reducer 并存。
    spec315a：state 有 deck（含 App 编辑回灌的）则同时重渲 .pptx，merge 覆盖旧 pptx key 同名对象。"""
    async def export_node(state):
        meta = (state.get("read") or {}).get("project_meta", {})
        data = render_docx(state.get("outline") or {}, state.get("chapters") or {}, meta=meta)
        key = await upload_artifact(
            ctx, "bid.docx", data,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        artifacts = {"docx": key}
        deck = state.get("deck")
        if deck:   # 编辑后 deck 的导出由此生效（overrides 已在续跑前灌入 state）
            pptx = render_pptx(DeckSpec.model_validate(deck))
            artifacts["pptx"] = await upload_artifact(
                ctx, "present.pptx", pptx,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        return {"artifacts": artifacts}
    return export_node
