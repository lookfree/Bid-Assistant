from __future__ import annotations
from langgraph.graph import StateGraph, START, END
from agent.agents.bidding_agent.state import BiddingState
from agent.agents.bidding_agent.nodes.read import make_read_node
from agent.agents.bidding_agent.nodes.outline import make_outline_node
from agent.agents.bidding_agent.nodes.content import make_content_node
from agent.agents.bidding_agent.nodes.review import make_review_node
from agent.agents.bidding_agent.nodes.present import make_present_node
from agent.agents.bidding_agent.nodes.export import make_export_node

NODE_ORDER = ["read", "outline", "content", "review", "present", "export"]


def _requested_step(state) -> str | None:
    return (state.get("run_input") or {}).get("step")


def _route_entry(state):
    """新线程入口（spec328 独立审查）：不带招标文件的线下标书审查直接进 review
    （read 为空 → 通用自查模式）；缺省从 read 起,与既有流水线一致。"""
    return "review" if _requested_step(state) == "review" else "read"


def _route_after_read(state):
    """read 后路由（spec328 对照审查）：审查专用项目读标完成后直达 review,
    跳过 outline/content（外部标书的 chapters 由 review 节点确定性解析,无需生成）。"""
    return "review" if _requested_step(state) == "review" else "outline"


def _route_after_review(state):
    """述标（present）是独立可选步：review 后本 run 显式请求 export 时直达 export，
    不再强制先跑述标（用户口径：下载标书不要求完成述标生成）。"""
    return "export" if _requested_step(state) == "export" else "present"


def _route_after_export(state):
    """export 后按请求路由：present=补跑述标（补跑后重导出可带 PPT）；export=重渲文件
    （渲染器升级/模板调整后重出）；其余结束。"""
    step = _requested_step(state)
    return step if step in ("present", "export") else END


def build_bidding_workflow(ctx):
    """投标工作流：6 节点串联 + review/export 两处条件边，每个节点后 interrupt（每步一个 run）。
    checkpointer 来自 ctx（PostgresSaver，§4.7），保证同 thread_id 续 BiddingState。"""
    g = StateGraph(BiddingState)
    g.add_node("read", make_read_node(ctx))
    g.add_node("outline", make_outline_node(ctx))
    g.add_node("content", make_content_node(ctx))
    g.add_node("review", make_review_node(ctx))
    g.add_node("present", make_present_node(ctx))
    g.add_node("export", make_export_node(ctx))
    g.add_conditional_edges(START, _route_entry, {"read": "read", "review": "review"})
    g.add_conditional_edges("read", _route_after_read, {"outline": "outline", "review": "review"})
    g.add_edge("outline", "content")
    g.add_edge("content", "review")
    g.add_conditional_edges("review", _route_after_review, {"present": "present", "export": "export"})
    g.add_edge("present", "export")
    g.add_conditional_edges("export", _route_after_export, {"present": "present", "export": "export", END: END})
    # 每个节点产出后暂停 → App 在对应原型页确认后发新 run 续跑
    return g.compile(checkpointer=ctx.checkpointer, interrupt_after=NODE_ORDER)
