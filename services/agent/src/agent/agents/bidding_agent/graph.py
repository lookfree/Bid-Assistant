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


def build_bidding_workflow(ctx):
    """投标工作流：6 节点顺序串联，每个节点后 interrupt（每步一个 run）。
    checkpointer 来自 ctx（PostgresSaver，§4.7），保证同 thread_id 续 BiddingState。"""
    g = StateGraph(BiddingState)
    g.add_node("read", make_read_node(ctx))
    g.add_node("outline", make_outline_node(ctx))
    g.add_node("content", make_content_node(ctx))
    g.add_node("review", make_review_node(ctx))
    g.add_node("present", make_present_node(ctx))
    g.add_node("export", make_export_node(ctx))
    g.add_edge(START, "read")
    for a, b in zip(NODE_ORDER, NODE_ORDER[1:]):
        g.add_edge(a, b)
    g.add_edge("export", END)
    # 每个节点产出后暂停 → App 在对应原型页确认后发新 run 续跑
    return g.compile(checkpointer=ctx.checkpointer, interrupt_after=NODE_ORDER)
