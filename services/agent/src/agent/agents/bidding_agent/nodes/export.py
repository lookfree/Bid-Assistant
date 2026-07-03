from __future__ import annotations
from agent.agents.bidding_agent.render.docx import render_docx
from agent.agents.bidding_agent.nodes.common import upload_artifact


def make_export_node(ctx):
    """graph 节点：读 outline+chapters → 渲染完整标书 .docx → 落 MinIO → 写 artifacts['docx']。
    普通服务节点：确定性、无 LLM、不碰钱。与 present 的 pptx 由 state.artifacts 合并 reducer 并存。"""
    async def export_node(state):
        meta = (state.get("read") or {}).get("project_meta", {})
        data = render_docx(state.get("outline") or {}, state.get("chapters") or {}, meta=meta)
        key = await upload_artifact(
            ctx, "bid.docx", data,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        return {"artifacts": {"docx": key}}
    return export_node
