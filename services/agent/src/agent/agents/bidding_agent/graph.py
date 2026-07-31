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


_STANDALONE_STEPS = ("review", "present")  # spec328 独立入口：可绕过流水线直达的节点


def _route_by_step(state, default: str) -> str:
    """spec328 独立入口路由：run_input.step 显式请求 review/present 时直达该节点（线下标书的 chapters
    由目标节点用 bid_file_key 确定性解析，无需先跑生成链）；否则走 default（既有流水线）。
    _route_entry（新线程，default=read）与 _route_after_read（读标后，default=outline）共用。"""
    step = _requested_step(state)
    return step if step in _STANDALONE_STEPS else default


def _route_entry(state):
    return _route_by_step(state, "read")


def _route_after_read(state):
    return _route_by_step(state, "outline")


def _route_after_content(state):
    """废标体检（review）是可跳过的付费步（用户口径「不想查的人不该被强收 60 积分」）：
    正文写完后本 run 显式请求 export/present 就直达该节点——述标与导出都不依赖体检报告。
    **这条边必须是条件边**——写成静态边时，
    停在 content 后的检查点无论请求哪一步都会先跑 review 节点：用户点的是导出，实际跑的是
    一轮审查大模型，产物写成 export 步结果、导出费照扣、docx 根本没渲染（评审实测复现）。"""
    step = _requested_step(state)
    return step if step in ("export", "present") else "review"


def _route_after_review(state):
    """述标（present）是独立可选步：review 后本 run 显式请求 export 时直达 export，
    不再强制先跑述标（用户口径：下载标书不要求完成述标生成）。"""
    return "export" if _requested_step(state) == "export" else "present"


def _route_after_present(state):
    """述标后按本 run 显式请求路由。**这条边必须是条件边**——写成静态边时，停在 present 之后的
    检查点在下一次 run 续跑时无条件跑 export：用户点的是「重新生成述标」，实际跑的是导出，
    export 的产物快照 {pdf,docx,pptx,pdfPages} 被当成 present 步结果存进 present 行，
    前端 realDeck.slides 变 undefined → 述标页整页崩（2026-07-31 项目 8edb7ff2 实测复现）。
    与 _route_after_content 当年那次是同一类问题：那条修了，这条漏了。
    取值与 _route_after_export 对齐（present 重跑 / export 导出 / review 补跑体检），其余结束。"""
    step = _requested_step(state)
    return step if step in ("present", "export", "review") else END


def _route_after_export(state):
    """export 后按请求路由：present=补跑述标（补跑后重导出可带 PPT）；export=重渲文件
    （渲染器升级/模板调整后重出）；review=补跑废标体检（跳过体检直出的项目事后想查——
    不给这条边，那个项目的体检就永远买不到了）；其余结束。"""
    step = _requested_step(state)
    return step if step in ("present", "export", "review") else END


def build_bidding_workflow(ctx):
    """投标工作流：6 节点串联，除 outline→content 外全部条件边，每个节点后 interrupt（每步一个 run）。
    静态边在「检查点停在该节点之后」时会让续跑越界跑下一节点，把下一节点的结果当本步结果回传——
    content→review、present→export 都因此出过生产事故，故新增边一律用条件边。
    checkpointer 来自 ctx（PostgresSaver，§4.7），保证同 thread_id 续 BiddingState。"""
    g = StateGraph(BiddingState)
    g.add_node("read", make_read_node(ctx))
    g.add_node("outline", make_outline_node(ctx))
    g.add_node("content", make_content_node(ctx))
    g.add_node("review", make_review_node(ctx))
    g.add_node("present", make_present_node(ctx))
    g.add_node("export", make_export_node(ctx))
    g.add_conditional_edges(START, _route_entry, {"read": "read", "review": "review", "present": "present"})
    g.add_conditional_edges("read", _route_after_read, {"outline": "outline", "review": "review", "present": "present"})
    g.add_edge("outline", "content")
    g.add_conditional_edges("content", _route_after_content,
                            {"review": "review", "export": "export", "present": "present"})
    g.add_conditional_edges("review", _route_after_review, {"present": "present", "export": "export"})
    g.add_conditional_edges("present", _route_after_present,
                            {"present": "present", "export": "export", "review": "review", END: END})
    g.add_conditional_edges("export", _route_after_export,
                            {"present": "present", "export": "export", "review": "review", END: END})
    # 每个节点产出后暂停 → App 在对应原型页确认后发新 run 续跑
    return g.compile(checkpointer=ctx.checkpointer, interrupt_after=NODE_ORDER)
