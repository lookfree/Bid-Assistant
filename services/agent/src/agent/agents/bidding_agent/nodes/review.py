from __future__ import annotations
import asyncio
import json
import re
from agent.framework.create_agent import run_submit_agent
from agent.parsing.service import read_and_parse
from agent.agents.bidding_agent.nodes.common import slim_read, filter_read_by_package, publish_phase
from agent.agents.bidding_agent.schemas import RiskReport
from agent.agents.bidding_agent.prompts.review import REVIEW_SYSTEM_PROMPT


_CHAPTER_CAP = 4000  # 每章喂给审查模型的正文上限（合规要点集中在前部；整本不截会顶穿上下文窗）


def _parse_bid_chapters(key: str) -> dict[str, str]:
    """线下标书 → chapters（spec328 独立审查）：确定性解析,按节聚合成 {sec-N: html}。
    无 LLM、不计费;解析失败抛错由节点层转 run 失败（App 侧退款）。"""
    parsed = read_and_parse(key)
    by_sec: dict[str, list[str]] = {}
    for c in parsed.clauses:
        m = re.match(r"^(sec-\d+)-", c.get("id") or "")
        if m:
            by_sec.setdefault(m.group(1), []).append(c.get("text") or "")
    return {sec: "".join(f"<p>{t}</p>" for t in texts if t) for sec, texts in by_sec.items()}


# 通用自查（未提供招标文件）的口径说明:必须明示局限,防用户把自查结果当成对照审查结论
_SELF_CHECK_NOTE = (
    "\n【通用自查模式】本次未提供招标文件:只做标书自身的完整性、格式规范、常见废标点、"
    "敏感与前后矛盾表述的自查,不做招标条款对照。risk_summary 第一条必须原样写:"
    "「未提供招标文件,未做招标条款对照审查,以下为通用自查结果」。"
)


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
        if not chapters_src and run_input.get("bid_file_key"):
            chapters_src = await asyncio.to_thread(_parse_bid_chapters, run_input["bid_file_key"])
        chapters = {cid: (html[:_CHAPTER_CAP] + "…（截断）" if len(html) > _CHAPTER_CAP else html)
                    for cid, html in chapters_src.items()}
        payload = {"read": slim_read(read_state), "outline": state.get("outline") or {},
                   "chapters": chapters}
        structure = read_state.get("required_structure") or []
        if structure:
            payload["required_structure"] = structure
        mode_note = "" if read_state else _SELF_CHECK_NOTE
        user = f"招标与投标材料：\n{json.dumps(payload, ensure_ascii=False)}{mode_note}\n请审查并提交体检报告。"
        result = await run_submit_agent(
            ctx, REVIEW_SYSTEM_PROMPT, user,
            "submit_risk_report", RiskReport, "提交审查报告")
        return {"risk": result.model_dump()}
    return review_node
