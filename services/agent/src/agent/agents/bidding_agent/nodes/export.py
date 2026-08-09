from __future__ import annotations
import asyncio
import json
import logging
from datetime import datetime, timezone
from agent.agents.bidding_agent.render.docx import render_docx
from agent.agents.bidding_agent.render.pdf import docx_to_pdf, pdf_page_count
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.nodes.common import upload_artifact, fetch_master_bytes, strip_inline_images
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
        # 内联图片的 base64 对扫描毫无意义，只会让待扫文本膨胀几十倍
        chapters_text = "\n".join(strip_inline_images(h) for h in (state.get("chapters") or {}).values())
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
    spec326：渲染前先跑一次敏感词扫描（_scan_and_flag，record-only，见其文档串）。
    2026-08-08 导出分册：run_input.export_scope 为 "tech"/"business" 时按 group 过滤章节
    （分组口径与预算一致：tech 组进技术册，其余含未标组归商务册），产物键与文件名带
    _tech/_biz 后缀，与全量键互不覆盖；过滤后空册抛 RuntimeError（防御，前端本已置灰）。
    缺省/未知 scope 一律按 full 处理，键与调用与今天逐字节一致；pptx 分支不受 scope 影响
    （终审 M2：未知字面量此前只在章节过滤/产物后缀两处按 full 兜底，传给 render_docx 的 scope
    仍是原始未知值——渲染器据此决定「章标题是否带（技术标/商务标）组尾巴」，于是全量章节配上
    了空尾巴，读者分不清这是不是分册；现在归一发生在读取 run_input 之后的唯一出口，三处下游
    （过滤/后缀/render_docx）逐字节同看到 "full"）。
    终审 C1：artifacts 是跨 run 合并 reducer（present 的 pptx 与 export 的 docx 并存不覆盖），
    docx/docx_tech/docx_biz 一旦产出，键值永远不变（MinIO key 按 thread_id 确定性命名、原地覆盖），
    单看某一行 result 是否含某册的 docx 键，分不出「这行是不是真重渲了那册」——不同册各自导出时
    互不清空对方的键，App 侧若只按「result 含 docx 键」判断某册的最近导出时刻，会把很久以前的
    全量导出误判成刚发生（前端下载区据此显示「未过期」，用户下到改稿前的旧文件却看不到提示）。
    exported_at{_tech/_biz} 每次本册真渲染都刷新为当次时间戳，不改动的册原样带着旧值，
    是这行 result 里唯一「只随本册变化」的字段，供 App 的 export-preview 接口据此判断各册
    是否在最近一次内容变更之后重新导出过。"""
    async def export_node(state):
        meta = (state.get("read") or {}).get("project_meta", {})
        run_input = state.get("run_input") or {}
        package = run_input.get("package")
        credentials_input = run_input.get("credentials")
        credentials = (await _fetch_credentials(credentials_input)
                       if credentials_input else None)
        await _scan_and_flag(ctx, state)
        # spec 2026-08-08 导出分册：export_scope 缺省/未知值一律按 full 处理，逐字节兼容旧调用
        scope = run_input.get("export_scope") or "full"
        if scope not in ("tech", "business"):  # 终审 M2：未知字面量归一到 full，别只清空后缀漏了 render_docx 的 scope 参
            scope = "full"
        outline = state.get("outline") or {}
        if scope in ("tech", "business"):
            # 分组口径与预算一致：tech 组进技术册，其余（含未标组）归商务册
            wanted = [c for c in outline.get("chapters", [])
                      if (c.get("group") == "tech") == (scope == "tech")]
            if not wanted:
                raise RuntimeError("该册没有章节，无法导出")
            outline = {**outline, "chapters": wanted}
        sfx = {"tech": "_tech", "business": "_biz"}.get(scope, "")
        data = render_docx(outline, state.get("chapters") or {},
                            meta=meta, package=package, credentials=credentials,
                            fmt=run_input.get("format"), scope=scope)  # spec330 输出格式（缺省 None=现行样式）
        key = await upload_artifact(
            ctx, f"bid{sfx}.docx", data,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        # 终审 C1：本册真实渲染时刻——毫秒精度 + 数字时区偏移（timespec="milliseconds"，非默认的
        # 微秒精度），逐字节可被 JS `new Date()` 解析，App 侧拿它与 content_changed_at 比较新旧。
        rendered_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        artifacts = {f"docx{sfx}": key, f"exported_at{sfx}": rendered_at}
        # soffice 子进程最长 120s：丢线程池，别把单进程事件循环整体卡死（终审 Important 项）
        pdf_bytes = await asyncio.to_thread(docx_to_pdf, data)
        if pdf_bytes is not None:
            artifacts[f"pdf{sfx}"] = await upload_artifact(ctx, f"bid{sfx}.pdf", pdf_bytes, "application/pdf")
            # 真实页数回报（篇幅控制地面真值）：前端展示"实际 N 页",也是后续密度/超写校准的数据源。
            # 解析不出也写 None——state.artifacts 是 merge reducer,不显式覆写会把上一版页数带给新文档
            artifacts[f"pdf_pages{sfx}"] = pdf_page_count(pdf_bytes)
        else:
            # 本次 docx→pdf 失败:显式置空,且只置本册键。否则 merge reducer 让上一版的
            # pdf/pdf_pages 混进新结果——用户会下载到旧版式 PDF、看到旧文档的"实际 N 页"
            # （评审 F1,重导出改格式场景实翻）
            artifacts[f"pdf{sfx}"] = None
            artifacts[f"pdf_pages{sfx}"] = None
        deck = state.get("deck")
        if deck:   # 编辑后 deck 的导出由此生效（overrides 已在续跑前灌入 state）
            master_bytes = await fetch_master_bytes(deck.get("enterprise_template_id"))
            pptx = render_pptx(DeckSpec.model_validate(deck), master_bytes=master_bytes)
            artifacts["pptx"] = await upload_artifact(
                ctx, "present.pptx", pptx,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        return {"artifacts": artifacts}
    return export_node
