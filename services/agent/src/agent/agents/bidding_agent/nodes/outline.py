from __future__ import annotations
import asyncio
import hashlib
import json
import logging

from agent.config import settings
from agent.framework.create_agent import run_submit_agent
from agent.parsing import storage_read
from agent.agents.bidding_agent.nodes.common import slim_read, package_scope, filter_read_by_package, publish_phase
from agent.agents.bidding_agent.schemas import Outline
from agent.agents.bidding_agent.prompts.outline import OUTLINE_SYSTEM_PROMPT
from agent.agents.bidding_agent.prompts.categories import category_scope


def _structure_skeleton(items: list[dict]) -> str:
    """把 required_structure 渲染成骨架约束文本（spec321）：附加在用户消息末尾，
    要求每个 required=true 且 kind≠rule 的构成项都有对应章节并置 structure_ref。"""
    rows = [{"id": s.get("id"), "title": s.get("title"), "kind": s.get("kind"),
             "required": s.get("required", True), "notes": s.get("notes", "")} for s in items]
    return ("\n投标文件构成清单（骨架，required=true 且 kind≠rule 的项必须有对应章节并置 structure_ref；"
            f"价格/资格类表单章节正文占位即可）：\n{json.dumps(rows, ensure_ascii=False)}")


logger = logging.getLogger(__name__)

# 同一份招标文件 → 同一份提纲（2026-08-14 用户实测：同文件多跑几次,提纲 12↔15 章漂移,
# 相差很大）。键=文件字节哈希+系统提示词哈希(改提示词自动失效,不再靠手动升版)
# +范围域(选包/类别——不同包件的提纲本就该不同)。TTL 30 天。
_OUTLINE_TTL_S = 30 * 24 * 3600


def _read_file_bytes(key: str) -> bytes:
    """独立小函数：测试可替换、失败面单一。"""
    return storage_read.read_bytes(key)


async def _tender_digest(state: dict) -> str | None:
    """主招标文件字节哈希；取不到（无文件/存储抖动）返回 None＝本轮不缓存，绝不挡生成。"""
    files = state.get("files") or []
    key = str((files[0] or {}).get("key") or "") if files else ""
    if not key:
        return None
    try:
        data = await asyncio.to_thread(_read_file_bytes, key)
        return hashlib.sha256(data).hexdigest()[:24]
    except Exception:  # noqa: BLE001
        logger.warning("提纲缓存：读取招标文件字节失败，本轮不缓存", exc_info=True)
        return None


def _cache_key(digest: str, state: dict) -> str:
    scope = json.dumps({"package": (state.get("run_input") or {}).get("package"),
                        "category": (state.get("run_input") or {}).get("bid_category")},
                       ensure_ascii=False, sort_keys=True)
    pv = hashlib.sha256(OUTLINE_SYSTEM_PROMPT.encode("utf-8")).hexdigest()[:8]
    sc = hashlib.sha256(scope.encode("utf-8")).hexdigest()[:8]
    return f"{settings.redis_prefix}outline:{digest}:{pv}:{sc}"


def _remap_structure_refs(outline: dict, ref_titles: dict, structure: list[dict]) -> dict:
    """跨项目复用提纲时，structure_ref 指向**旧一轮读标**的构成项 id——id 由读标模型自拟，
    跨轮不稳。按标题精确重映射到本轮构成项；映射不上的删引用（模板定位/偏离投递都有
    标题兜底通路，缺引用只是少一条捷径，错引用才是事故）。"""
    by_title = {str(s.get("title") or ""): s.get("id") for s in structure}
    for ch in outline.get("chapters") or []:
        ref = ch.get("structure_ref")
        if not ref:
            continue
        new = by_title.get(str(ref_titles.get(str(ref)) or ""))
        if new:
            ch["structure_ref"] = new
        else:
            ch.pop("structure_ref", None)
    return outline


def make_outline_node(ctx):
    """graph 节点：读 state['read']（读标结论）→ 产 Outline → 写 state['outline']；模型未提交即失败（可重试）。
    read.required_structure 非空时追加骨架约束（spec321）；run_input.package 存在时追加包件范围约束
    （spec324）；均缺省时用户消息与此前行为字节级一致。"""
    async def outline_node(state):
        await publish_phase(ctx, "依据读标结论编排投标文件提纲")
        # 选包时读标收窄到该包(spec324 优化):提纲只按该包的需求/评分/构成搭建,上下文大降。
        read_state = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
        structure_now = read_state.get("required_structure") or []
        digest = await _tender_digest(state)
        key = _cache_key(digest, state) if digest else None
        r = getattr(ctx, "redis", None)
        if key and r:
            try:
                raw = await asyncio.to_thread(r.get, key)
            except Exception:  # noqa: BLE001 缓存 best-effort
                raw = None
            if raw:
                data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
                logger.info("提纲缓存命中（同文件同域），零模型复用")
                return {"outline": _remap_structure_refs(
                    data.get("outline") or {}, data.get("ref_titles") or {}, structure_now)}
        read = json.dumps(slim_read(read_state), ensure_ascii=False)
        user = f"读标结论：\n{read}\n请据此产出提纲。"
        structure = read_state.get("required_structure") or []
        if structure:
            user += _structure_skeleton(structure)
        user += package_scope(state.get("run_input"))
        # 分类必备章节（spec334）：只取主类别——提纲结构只能有一套，两套会膨胀出重复骨架
        user += category_scope((state.get("run_input") or {}).get("bid_category"), "chapters")
        # attempts=5（评审 2026-08-14）：两组必非空的语义校验上线后，省力模型可能连吃几轮
        # 拒绝——3 轮耗尽=整步失败退款，比多跑两轮糟得多（present 骨架同因放宽的先例）。
        # temperature=0（2026-08-14）：缓存未命中的首跑也要稳——提纲是结构决策,不该靠采样发挥
        result = await run_submit_agent(
            ctx, OUTLINE_SYSTEM_PROMPT, user,
            "submit_outline", Outline, "提交提纲", attempts=5, temperature=0.0)
        outline = result.model_dump()
        if key and r:
            payload = json.dumps(
                {"outline": outline,
                 "ref_titles": {str(s.get("id")): str(s.get("title") or "") for s in structure_now}},
                ensure_ascii=False)
            try:
                await asyncio.to_thread(r.set, key, payload, ex=_OUTLINE_TTL_S)
            except Exception:  # noqa: BLE001
                logger.warning("提纲缓存写入失败（不影响交付）", exc_info=True)
        return {"outline": outline}
    return outline_node
