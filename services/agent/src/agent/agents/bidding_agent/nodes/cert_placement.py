"""证照定向插章 post-pass（2026-08-09 资料库定向注入设计,计划③）：招标要求命中证照词表
× 章定位（clause_ids 交集，同 content.py 的 _requirements_lines 手法）× 资料库库存 三重命中，
章尾追加"见下图"占位图，或库无时追加"待补充"提示——不再赌 RAG 召回率把证照插对章。

**在缓存读写之外单独跑**：run_content_pipeline 收尾处 out 构建完（fresh 章刚写完 / 缓存章
刚命中）之后立即现算一遍，绝不写回 Redis 缓存——缓存里恒久存的是模型原稿，插图逻辑每轮
都按资料库当前状态重新决定，库存增删（用户在资料库加/删证照）下一轮立即生效，不必等提示词
版本哈希失效才能刷新占位图。

构建全程零 LLM：纯字符串拼接，与 credentials_chapter.py 的零 LLM 保证同一手法（审查专项：
证照条目/图片量不设上限，一旦有字符经过模型，会把简报顶穿上下文并白白计费）。
"""
from __future__ import annotations

from agent.agents.bidding_agent.nodes.common import filter_read_by_package
from agent.agents.bidding_agent.nodes.content import _collect_clause_ids
from agent.agents.bidding_agent.nodes.credentials_chapter import SYS_CREDS_ID, _esc, _image_alt

# 证照词表字面量——与计划 Global Constraints、web 侧 lib/cert-keywords.ts 逐字同形（两端各自
# 持有确定性实现,字面量一改就要同步改另一处，注释互指）。
CERT_KEYWORDS = ("营业执照", "资质证书", "授权书", "法定代表人身份证明", "检测证书", "许可证",
                 # 财务与资格类材料（2026-08-11 加）：康恒那单实测报出「近三年经审计的资产负债表
                 # 未提供」「银行资信证明未提供」，而这些材料就躺在资料库「财务材料」分类里，
                 # 既进不了附录章、也不会被定向插到要求它的章节——因为词表只覆盖资质类。
                 "审计报告", "资产负债表", "利润表", "财务报表", "纳税证明", "完税证明",
                 "社保证明", "银行资信证明", "开户许可证")

# post-pass 定位只看 read 结论里资格/商务两类条目——技术类要求命中证照字样极罕见且易误报。
_CERT_CATEGORY_KEYS = ("qualification", "commercial")
# `_image_alt`（标题|ocrText 截前 120 字）现收在 credentials_chapter.py：附录章占位图 alt
# 与本文件的章内插图 alt 是同一套格式（终审 I-4），不再各自持有一份实现。


def _cert_block(keyword: str, entry: dict | None) -> str:
    """单个证照词命中后的章尾追加块：库有该词对应条目 → 见下图 + 该条目逐图占位
    （三属性同 credentials_chapter.py 的 build_credentials_chapter,无 src 无字节）；
    库无 → 待补充提示。"""
    if entry is None:
        return f"<p>（待补充：{_esc(keyword)}）</p>"
    title = str(entry.get("title") or "").strip()
    parts = [f"<p>【{_esc(keyword)}】见下图：</p>"]
    for img in entry.get("images") or []:
        file_id = _esc(img.get("fileId"))
        key = _esc(img.get("key"))
        alt = _image_alt(title, img.get("ocrText"))
        parts.append(f'<p><img data-file-id="{file_id}" data-object-key="{key}" alt="{alt}" /></p>')
    return "\n".join(parts)


def _matched_keywords(read: dict, clause_ids: set[str]) -> list[str]:
    """本章命中的证照词（去重,保持词表序）：资格/商务类条目 title 命中词表某词,且该条目
    clause_ids 与本章子项 clause_ids（调用方传入）有交集——定位手法与 content.py 的
    _requirements_lines / _chapter_requirements 同源（_collect_clause_ids）。"""
    if not clause_ids:
        return []
    hit_titles: list[str] = []
    for cat in read.get("categories") or []:
        if cat.get("key") not in _CERT_CATEGORY_KEYS:
            continue
        for it in cat.get("items") or []:
            if set(it.get("clause_ids") or []) & clause_ids:
                hit_titles.append(str(it.get("title") or ""))
    hits = [kw for kw in CERT_KEYWORDS if any(kw in t for t in hit_titles)]
    # 词表里存在包含关系（「开户许可证」⊃「许可证」）：两个都命中就会为同一份材料插两遍图。
    # 保留更具体的那个——被别的命中词整个包含的词一律丢弃。
    return [kw for kw in hits if not any(kw != other and kw in other for other in hits)]


def place_certificates(out: dict[str, str], state: dict) -> dict[str, str]:
    """post-pass 入口（纯函数,返回新 dict,不改动入参）：对 out 中每个非系统章追加命中的
    证照占位（或待补充提示）。定位不到章（子项无 clause_ids 或与要求无交集）或词表不命中
    → 该章原样不动（附录/程序性章节天然兜底）。sys-creds 结构性排除，双重兜底（id 与
    system 标记，与 content_pipeline.py 净化系统章同一手法）——绝不触碰。"""
    outline = state.get("outline") or {}
    chapters = {c.get("id"): c for c in outline.get("chapters") or []
                if c.get("id") and not c.get("system") and c.get("id") != SYS_CREDS_ID}
    read = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
    credentials = (state.get("run_input") or {}).get("credentials") or []

    result = dict(out)
    for cid, html in out.items():
        ch = chapters.get(cid)
        if ch is None or not html:
            continue
        keywords = _matched_keywords(read, _collect_clause_ids(ch.get("items")))
        if not keywords:
            continue
        blocks = []
        for kw in keywords:
            entry = next((c for c in credentials if kw in str(c.get("title") or "")), None)
            blocks.append(_cert_block(kw, entry))
        result[cid] = html + "\n" + "\n".join(blocks)
    return result
