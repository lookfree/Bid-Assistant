from __future__ import annotations
import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from agent.agents.bidding_agent.render.docx import render_docx
from agent.agents.bidding_agent.render.pdf import docx_to_pdf, pdf_page_count
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.nodes.common import upload_artifact, fetch_master_bytes, strip_inline_images
from agent.framework.content_safety import scan_text
from agent.parsing import storage_read

logger = logging.getLogger(__name__)


# 正文章 id 形态（t1/b3…）：agent_request.result 里长这样的键即 content run 的章表
_CID_RE = re.compile(r"^[tb]\d+$")


def _copier_baseline(thread_id: str) -> dict:
    """最新 content run 的原始章表（pristine 判定基准：App 编辑只覆写 project_steps，
    agent_request.result 是模型产出的未动副本）。SQL 侧按「键长得像章 id」直接锁定那一行，
    **只拉一行一列**——不许把近几轮的整本 result 拖过隧道（slim 教训，评审 2026-08-14 F7），
    也不吃「最近 N 轮」窗口的亏（导出/审查再多轮也压不掉它，F12）。"""
    from agent.db import get_pool

    with get_pool().connection() as conn:
        row = conn.execute(
            "select result from agent.agent_request "
            "where thread_id=%s and status='succeeded' "
            "  and jsonb_typeof(result)='object' "
            "  and exists (select 1 from jsonb_object_keys(result) k where k ~ '^[tb][0-9]+$') "
            "order by finished_at desc nulls last limit 1", (thread_id,)).fetchone()
    return row[0] if row and isinstance(row[0], dict) else {}


async def _copier_event(ctx, event_type: str, data: dict, level: str = "info") -> None:
    """复印机观测（form_copier_ok / form_copier_fallback）落 agent_event_log，best-effort。"""
    recorder = getattr(ctx, "recorder", None)
    if recorder is None or not getattr(ctx, "run_id", None):
        return
    try:
        await asyncio.to_thread(
            recorder.log_event, ctx.run_id, getattr(ctx, "agent_type", "bidding_agent"),
            event_type, node="export", level=level, data=data,
            thread_id=getattr(ctx, "thread_id", None))
    except Exception:  # noqa: BLE001 埋点绝不影响导出
        logger.warning("copier event log failed", exc_info=True)


async def _copier_nodes(ctx, state: dict, outline: dict) -> dict[str, list]:
    """表单章复印机（spec 2026-08-14 T5，评审整改后）：{章id: 招标原样 XML 节点}。

    顺序（评审 F8：零候选不查库不下载）：候选=形态学表单章（偏离表整词排除）→ 招标主文件
    是 .docx（state["files"][0]，App 排主文件在前——不拿"任意第一个 docx"，答疑册会顶包，F13）
    → 基线锁行查询 → 定位**全体候选**再去重（先去重后过滤 pristine，否则手改的子表单
    留在被复印的父表里重复一遍，F2）→ pristine 过滤 → 批量抽取+填空整体丢线程池（F3）。
    自定义导出格式（run_input.format）**不再整体让路**（2026-08-14 生产实证：这家客户
    每次导出都带格式配置，让路等于复印机永久关闭）：嫁接段落由 graft_nodes 打缩进免疫
    （无显式缩进的补 firstLine=0），字体/行距随全书格式统一本就是用户配置的意图。
    任何失败逐章让路。"""
    from agent.agents.bidding_agent.nodes.bidder_profile import (
        authorized_rep_fields, bidder_fields)
    from agent.agents.bidding_agent.nodes.form_locate import (
        _looks_like_form_title, build_form_index, dedupe_spans, form_node_span)
    from agent.agents.bidding_agent.render.form_copier import copy_forms
    from agent.parsing.parsers import parse_bytes

    run_input = state.get("run_input") or {}
    files = state.get("files") or []
    main_key = str((files[0] or {}).get("key") or "") if files else ""
    if not main_key.lower().endswith(".docx"):
        return {}
    chapters_now = state.get("chapters") or {}
    candidates = {c.get("id") or "": c.get("title") or ""
                  for c in outline.get("chapters", [])
                  if "偏离表" not in (c.get("title") or "")           # 整词，裸「偏离」误伤承诺函
                  and _looks_like_form_title(c.get("title") or "")}
    if not candidates:
        return {}
    try:
        original = await asyncio.to_thread(_copier_baseline, ctx.thread_id)
    except Exception:  # noqa: BLE001 基线查不到=让路
        logger.warning("复印机基线查询失败，整体让路", exc_info=True)
        return {}
    pristine = {cid for cid in candidates
                if original.get(cid) and original.get(cid) == chapters_now.get(cid)}
    if not pristine:
        return {}
    try:
        data = await asyncio.to_thread(storage_read.read_bytes, main_key)
        parsed = await asyncio.to_thread(parse_bytes, data, main_key.rsplit("/", 1)[-1])
        index = build_form_index({"doc_sections": parsed.clauses,
                                  "doc_headings": parsed.headings})
    except Exception as e:  # noqa: BLE001 招标文件取不回/解析不了=全体让路
        await _copier_event(ctx, "form_copier_fallback",
                            {"chapter": "*", "reason": f"招标解析失败:{e}"[:200]}, "warn")
        return {}
    spans = {cid: sp for cid, title in candidates.items()
             if (sp := form_node_span(index, title))}
    spans = {cid: sp for cid, sp in dedupe_spans(spans).items() if cid in pristine}
    if not spans:
        return {}
    refs = run_input.get("library_refs") or {}
    fields = (bidder_fields(refs.get("company") or [])
              + authorized_rep_fields(refs.get("personnel") or []))
    meta = (state.get("read") or {}).get("project_meta") or {}
    try:
        ok, fail = await asyncio.to_thread(copy_forms, data, spans, fields, meta)
    except Exception as e:  # noqa: BLE001 批处理级意外=全体让路
        await _copier_event(ctx, "form_copier_fallback",
                            {"chapter": "*", "reason": f"意外:{e}"[:200]}, "warn")
        return {}
    for cid, (_nodes, filled) in ok.items():
        await _copier_event(ctx, "form_copier_ok", {"chapter": cid, "filled": filled})
    for cid, reason in fail.items():
        await _copier_event(ctx, "form_copier_fallback",
                            {"chapter": cid, "reason": reason[:200]}, "warn")
    # 已就位证照图不丢（2026-08-14 授权书实测）：复印替换会让全书唯一一份执照/身份证
    # 凭空消失。从当前章 HTML 抽出证照块（「见下图」引导行+带 data-file-id 的图）作章尾，
    # 复印模板 XML 之后由渲染层追加——招标版式与证照两头都保住。
    return {cid: {"nodes": nodes, "tail": _cert_tail(chapters_now.get(cid) or "")}
            for cid, (nodes, _f) in ok.items()}


_CERT_TAIL_RE = re.compile(
    r"(?:<p[^>]*>【[^】]{1,24}】见下图：?</p>\s*)?<p[^>]*>\s*<img[^>]*data-file-id[^>]*>\s*</p>"
    r"|<img[^>]*data-file-id[^>]*>", re.S)


def _cert_tail(html: str) -> str:
    """当前章 HTML 里的证照块（引导行+占位图）→ 复印章的章尾 HTML；没有给空串。"""
    return "\n".join(m.group(0) for m in _CERT_TAIL_RE.finditer(html or ""))


def _fetch_object(key: str) -> bytes | None:
    """render_docx 附录占位图取字节回调（2026-08-09 资质附录系统章节 Plan A①）：附录已在
    content 步前置成生成期系统章节，chapters 里的占位图只带 MinIO key，字节留到渲染这一刻
    才取。这里保持同步实现——调用方 export_node 已把整个 render_docx 调用（含本回调触发的
    MinIO 网络 I/O）经 asyncio.to_thread 整体丢进线程池，回调本身无需再包一层；取不到时向上
    抛的异常由 render_docx 捕获落「图片加载失败」占位行，这里不吞异常。"""
    return storage_read.read_bytes(key)


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
    2026-08-09 资质附录系统章节 Plan A①：附录不再是导出步独有的逻辑——它在 content 步收尾就
    已前置为 chapters 里的普通系统章（sys-creds），随其余章节一起走 outline 顺序渲染；
    这里只需把取字节回调 fetch_object 传给 render_docx，章内 `<img data-object-key>` 占位图
    由渲染层统一解析（取不到落占位行），导出步不再单独下发/预取 credentials。
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
        # 节点入口就打点（run 开始语义），不是渲染完成才打点：render_docx/docx_to_pdf 加起来能跑
        # 到几十秒，若在那之后才取时间戳，导出运行期间发生的编辑会落在「编辑时刻 < exported_at」——
        # 前端 clearExportDirty 按 runStartedAt 口径判断"是否已在这次编辑之后重新导出过"会误判
        # 这次导出已经覆盖了那次编辑，而实际渲染读到的是编辑前的旧正文（评审 2026-08-09）。
        # 终审 C1：本册渲染时刻——毫秒精度 + 数字时区偏移（timespec="milliseconds"，非默认的
        # 微秒精度），逐字节可被 JS `new Date()` 解析，App 侧拿它与 content_changed_at 比较新旧。
        rendered_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        meta = (state.get("read") or {}).get("project_meta", {})
        run_input = state.get("run_input") or {}
        package = run_input.get("package")
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
        # 表单章复印机（spec 2026-08-14）：整体 best-effort——它自己兜掉一切异常，
        # 返回空 dict 时 render_docx 行为与从前逐字节一致
        copier = await _copier_nodes(ctx, state, outline)
        data = await asyncio.to_thread(render_docx, outline, state.get("chapters") or {},  # 同步 MinIO I/O（fetch_object）+ CPU 渲染一并丢线程池，不裸跑事件循环卡住同进程所有在途 run（与下面 docx_to_pdf 同理）
                                        meta=meta, package=package, fetch_object=_fetch_object,
                                        fmt=run_input.get("format"), scope=scope,  # spec330 输出格式（缺省 None=现行样式）
                                        copier_nodes=copier or None)
        key = await upload_artifact(
            ctx, f"bid{sfx}.docx", data,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
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
