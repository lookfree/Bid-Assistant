from __future__ import annotations
import asyncio
import json
from agent.framework.budget import run_with_shrink
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import (
    slim_read, filter_read_by_package, parse_bid_chapters, publish_phase, html_to_review_text,
    allocate_chapter_budget, chapters_budget, compress_read, MIN_CHAPTER_CHARS,
)
from agent.agents.bidding_agent.nodes.classify import classify_from_chapters, empty_category
from agent.agents.bidding_agent.schemas import RiskReport
from agent.agents.bidding_agent.prompts.review import REVIEW_SYSTEM_PROMPT
from agent.agents.bidding_agent.prompts.categories import category_scope, industry_patches




# 通用自查（未提供招标文件）的口径说明:必须明示局限,防用户把自查结果当成对照审查结论
_SELF_CHECK_NOTE = (
    "\n【通用自查模式】本次未提供招标文件:只做标书自身的完整性、格式规范、常见废标点、"
    "敏感与前后矛盾表述的自查,不做招标条款对照。risk_summary 第一条必须原样写:"
    "「未提供招标文件,未做招标条款对照审查,以下为通用自查结果」。"
)


async def _resolve_category(ctx, run_input: dict, read_state: dict, chapters: dict[str, str]) -> tuple[dict, bool]:
    """本次审查生效的分类，以及**它是不是本节点现判出来的**（第二个返回值）。三条路：
    ① run_input **带这个键**（含空数组）→ 用户已表态，直接用、不再判。
       **必须按「键在不在」判断而不是真值**：空数组是「用户明确不用分类」，
       当成缺失会让下面两条路把知识又注回去，用户根本关不掉。
    ② 有读标结论 → 读标步已判过，不重复烧钱，取那一份；
    ③ 自查模式（没有招标文件、也就没有读标结论）→ 拿上传标书正文现判。

    为什么要回报「是不是现判的」：只有 ③ 才是真正的**系统判定**，值得随结果落库当判定值。
    ①②回写的话，App 侧读「最近一条带分类的步结果」会读到用户自己的选择，把它当成系统判定——
    纠偏样本会记出「系统从没做过的判错」，清除确认值也会回落到用户自己的旧选择。"""
    if "bid_category" in run_input:
        return {**empty_category(), "value": list(run_input["bid_category"] or [])}, False
    if read_state:
        return (read_state.get("bid_category") or empty_category()), False
    return await classify_from_chapters(ctx, chapters), True


def make_review_node(ctx):
    """graph 节点：读 read+outline+chapters 比对 → 产 RiskReport → 写 state['risk']；模型未提交即失败（可重试）。
    read 走 slim_read 裁 source_quote；章节正文按 _CHAPTER_CAP 截断（防超窗）；
    read.required_structure 非空时一并注入（spec321，供构成覆盖比对），为空时 payload 与此前一致。"""
    async def review_node(state):
        await publish_phase(ctx, "逐条比对招标要求与标书内容")
        # 选包时读标收窄到该包(spec324 优化):审查只比对该包要求,不会把别包的要求误判成缺失。
        read_state = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
        run_input = state.get("run_input") or {}
        chapters_src = state.get("chapters") or {}
        # spec328 独立审查:线下标书没有生成链路,chapters 由上传文件确定性解析而来
        bid_files = run_input.get("bid_file_keys") or (
            [run_input["bid_file_key"]] if run_input.get("bid_file_key") else []
        )
        if not chapters_src and bid_files:
            chapters_src = await asyncio.to_thread(parse_bid_chapters, bid_files)
            # 审查修正：解析为空（扫描件/图片 PDF 提不出文字）绝不能拿空文档去跑计费审查——
            # run 直接失败,App 侧 settleFailed 全额退款,错误文案告知原因
            if not chapters_src:
                raise RuntimeError("上传的标书未能解析出任何正文（扫描件/图片版暂不支持），请上传可复制文字的 docx/pdf 后重试")
        # 截断前先压实成紧凑文本：图片换占位符（一张 base64 就有二十万字符，2026-08-06 用户反馈
        # 「证照放进正文、审查却报缺件」的真因），HTML 标签与实体一并剥掉——2026-08-07 全量实测
        # 喂进去的字符有 **56% 是标签**，有一章正文才 5261 字、本可整章放下，却因表格标签把串撑到
        # 38431，模型只读到 561 字（10%）。表格结构保留成「单元格 | 单元格 / 换行」，
        # 因为审查要靠表格行判断★条款有没有逐条登进偏离表。
        texts = {cid: html_to_review_text(html) for cid, html in chapters_src.items()}
        # 分类判定（spec334）：**在审查之前**做，这一轮就能用上分类知识——放到审查之后的话，
        # 用户看到分类时报告已经出完，得再花一次钱重跑才生效。
        # 有读标结论的项目在读标步已判过，这里不重复判；用户确认过的值优先。
        # 用未截断的 texts 判：分类只取每章开头若干字（_chapters_summary 自带上限），不吃预算。
        category, self_detected = await _resolve_category(ctx, run_input, read_state, texts)
        # 读标结论先压进额度的一半：实测最大一份 210311 tokens（2747 个条目），
        # 单它一个就是窗口的两倍，这种项目光截正文没有用。★条款与废标风险条一条不动。
        payload = {"read": compress_read(slim_read(read_state), chapters_budget(ctx, "")),
                   "outline": state.get("outline") or {},
                   "chapters": {}}     # chapters 占位保住键序，额度算完再填
        structure = read_state.get("required_structure") or []
        if structure:
            payload["required_structure"] = structure
        mode_note = "" if read_state else _SELF_CHECK_NOTE
        # 分类必查项（spec334）：**主次类别都取**——查多了只多看一眼，漏一条是废标。
        # 行业资质补丁在读标条目（有招标文件）或标书正文（自查）上做字面匹配，不拿全文匹配：
        # 补丁词是资质类术语，只出现在需求与资格条款里，全文匹配只增噪声和成本。
        # 判据用 read_state 而不是 payload["read"]：slim_read({}) 回的是
        # {"project_meta": {}, "categories": [], ...}——**非空 dict 恒为真**，
        # 写成 `payload["read"] or texts` 就永远取不到正文，自查项目的资质补丁静默全失效。
        extra = category_scope(category.get("value"), "review")
        extra += industry_patches(json.dumps(payload["read"] if read_state else texts,
                                             ensure_ascii=False))
        # 正文额度按剩余窗口算：固定部分（系统提示 + 读标结论 + 约束文字）先占，剩下的才是正文的。
        # 写死常量的下场见 chapters_budget 的注释——砍不够是 400，砍过头是白丢内容。
        fixed = REVIEW_SYSTEM_PROMPT + json.dumps(payload, ensure_ascii=False) + mode_note + extra
        budget = chapters_budget(ctx, fixed)

        async def _attempt(factor: float):
            """按给定折扣重建载荷再跑——估算失准时由 run_with_shrink 逐档收缩。"""
            payload["chapters"] = allocate_chapter_budget(
                texts, int(budget * factor), MIN_CHAPTER_CHARS)
            user = (f"招标与投标材料：\n{json.dumps(payload, ensure_ascii=False)}{mode_note}"
                    f"\n请审查并提交体检报告。{extra}")
            return await run_submit_agent(
                ctx, REVIEW_SYSTEM_PROMPT, user,
                "submit_risk_report", RiskReport, "提交审查报告")

        result = await run_with_shrink(_attempt, label="审查")
        # 与 read 节点同理：分类并进结果 dict，**不进 submit_risk_report 的工具 schema**。
        # 只有本节点现判出来的才落库当判定值——回显用户的选择会让它被当成系统判定（见 _resolve_category）。
        risk = result.model_dump()
        if self_detected:
            risk["bid_category"] = category
        return {"risk": risk}
    return review_node
