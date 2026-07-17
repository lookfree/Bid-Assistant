from __future__ import annotations
import asyncio
import json
import logging
from agent.agents.bidding_agent.render.docx import render_docx
from agent.agents.bidding_agent.render.pdf import docx_to_pdf
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.nodes.common import upload_artifact, fetch_master_bytes
from agent.framework.content_safety import scan_text
from agent.parsing import storage_read

logger = logging.getLogger(__name__)


async def _fetch_credential_image(key: str) -> dict:
    """单张证照图片按 MinIO key 预取字节；取图失败（网络抖动/坏 key）→ data=None，
    交渲染层落一行占位文字，绝不中断导出（spec325 best-effort）。"""
    name = key.rsplit("/", 1)[-1]
    try:
        data = await asyncio.to_thread(storage_read.read_bytes, key)
    except Exception:
        data = None
    return {"name": name, "data": data}


async def _fetch_credentials(credentials: list[dict]) -> list[dict]:
    """逐条目逐图预取字节：render_docx 保持纯同步渲染，取图（唯一的 I/O）放在节点层。"""
    result = []
    for cred in credentials:
        images = await asyncio.gather(
            *(_fetch_credential_image(key) for key in cred.get("images", [])))
        result.append({"title": cred.get("title", ""), "images": list(images)})
    return result


async def _scan_and_flag(ctx, state: dict) -> None:
    """交付前敏感词扫描（spec326 备案「违法不良信息识别与发现机制」的机器侧）：只记录命中，
    绝不拦截、绝不改动生成内容。整体 try/except：词库缺失/recorder 或落库异常/任何意外状态，
    一律 logger.warning 后放行，绝不让扫描挡住导出交付（生产铁律）。无命中不写事件。"""
    try:
        chapters_text = "\n".join((state.get("chapters") or {}).values())
        deck = state.get("deck")
        text = chapters_text + (json.dumps(deck, ensure_ascii=False) if deck else "")
        hits = scan_text(text)
        if not hits:
            return
        await asyncio.to_thread(
            ctx.recorder.log_event, ctx.run_id, ctx.agent_type, "content_flag",
            node="export", level="warn", data={"words": sorted(hits), "counts": hits},
            thread_id=ctx.thread_id,
        )
    except Exception:  # noqa: BLE001 敏感词扫描/落库失败绝不阻断导出交付
        logger.warning("敏感词扫描失败，跳过", exc_info=True)


def make_export_node(ctx):
    """graph 节点：读 outline+chapters → 渲染完整标书 .docx → 落 MinIO → 写 artifacts['docx']。
    普通服务节点：确定性、无 LLM、不碰钱。与 present 的 pptx 由 state.artifacts 合并 reducer 并存。
    spec315a：state 有 deck（含 App 编辑回灌的）则同时重渲 .pptx，merge 覆盖旧 pptx key 同名对象。
    spec323：docx 落库后 best-effort 转 .pdf；转换失败不写 artifacts['pdf']，不影响 docx 产出。
    spec324：run_input.package 存在时封面带包件名。
    spec325：run_input.credentials 非空时预取图片字节，渲染追加「资格证明文件」附录；
    缺省不带 credentials 键时渲染调用与今天一致。
    企业母版：deck.enterprise_template_id 若给出（present 阶段已落库的 MinIO key），重渲时
    重新预取母版字节传给 render_pptx，保持编辑后重导出仍套用同一份企业母版；取不到静默回退
    空白设计，不影响 pptx 重渲。
    spec326：渲染前先跑一次敏感词扫描（_scan_and_flag，record-only，见其文档串）。"""
    async def export_node(state):
        meta = (state.get("read") or {}).get("project_meta", {})
        run_input = state.get("run_input") or {}
        package = run_input.get("package")
        credentials_input = run_input.get("credentials")
        credentials = (await _fetch_credentials(credentials_input)
                       if credentials_input else None)
        await _scan_and_flag(ctx, state)
        data = render_docx(state.get("outline") or {}, state.get("chapters") or {},
                            meta=meta, package=package, credentials=credentials)
        key = await upload_artifact(
            ctx, "bid.docx", data,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        artifacts = {"docx": key}
        # soffice 子进程最长 120s：丢线程池，别把单进程事件循环整体卡死（终审 Important 项）
        pdf_bytes = await asyncio.to_thread(docx_to_pdf, data)
        if pdf_bytes is not None:
            artifacts["pdf"] = await upload_artifact(ctx, "bid.pdf", pdf_bytes, "application/pdf")
        deck = state.get("deck")
        if deck:   # 编辑后 deck 的导出由此生效（overrides 已在续跑前灌入 state）
            master_bytes = await fetch_master_bytes(deck.get("enterprise_template_id"))
            pptx = render_pptx(DeckSpec.model_validate(deck), master_bytes=master_bytes)
            artifacts["pptx"] = await upload_artifact(
                ctx, "present.pptx", pptx,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        return {"artifacts": artifacts}
    return export_node
