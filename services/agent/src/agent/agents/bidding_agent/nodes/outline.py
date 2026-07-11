from __future__ import annotations
import json
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import slim_read, package_scope
from agent.agents.bidding_agent.schemas import Outline
from agent.agents.bidding_agent.prompts.outline import OUTLINE_SYSTEM_PROMPT


def _structure_skeleton(items: list[dict]) -> str:
    """把 required_structure 渲染成骨架约束文本（spec321）：附加在用户消息末尾，
    要求每个 required=true 且 kind≠rule 的构成项都有对应章节并置 structure_ref。"""
    rows = [{"id": s.get("id"), "title": s.get("title"), "kind": s.get("kind"),
             "required": s.get("required", True), "notes": s.get("notes", "")} for s in items]
    return ("\n投标文件构成清单（骨架，required=true 且 kind≠rule 的项必须有对应章节并置 structure_ref；"
            f"价格/资格类表单章节正文占位即可）：\n{json.dumps(rows, ensure_ascii=False)}")


def make_outline_node(ctx):
    """graph 节点：读 state['read']（读标结论）→ 产 Outline → 写 state['outline']；模型未提交即失败（可重试）。
    read.required_structure 非空时追加骨架约束（spec321）；run_input.package 存在时追加包件范围约束
    （spec324）；均缺省时用户消息与此前行为字节级一致。"""
    async def outline_node(state):
        read_state = state.get("read") or {}
        read = json.dumps(slim_read(read_state), ensure_ascii=False)
        user = f"读标结论：\n{read}\n请据此产出提纲。"
        structure = read_state.get("required_structure") or []
        if structure:
            user += _structure_skeleton(structure)
        user += package_scope(state.get("run_input"))
        result = await run_submit_agent(
            ctx, OUTLINE_SYSTEM_PROMPT, user,
            "submit_outline", Outline, "提交提纲")
        return {"outline": result.model_dump()}
    return outline_node
