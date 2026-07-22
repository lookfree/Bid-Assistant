from langgraph.checkpoint.memory import MemorySaver
from agent.agents.bidding_agent.graph import build_bidding_workflow, NODE_ORDER


class _FakeCtx:
    checkpointer = MemorySaver()   # interrupt_after 需 checkpointer；测试只验结构
    gateway = None

    def __getattr__(self, k):
        return None


def test_workflow_compiles_with_all_nodes():
    g = build_bidding_workflow(_FakeCtx())
    nodes = set(g.get_graph().nodes)
    for n in NODE_ORDER:
        assert n in nodes, f"缺节点 {n}"


def test_node_order_is_full_bidding_flow():
    assert NODE_ORDER == ["read", "outline", "content", "review", "present", "export"]


def test_route_after_review_skips_present_on_export_request():
    """述标独立可选：review 后显式请求 export → 直达 export；缺省/present → 走述标。"""
    from agent.agents.bidding_agent.graph import _route_after_review
    assert _route_after_review({"run_input": {"step": "export"}}) == "export"
    assert _route_after_review({"run_input": {"step": "present"}}) == "present"
    assert _route_after_review({"run_input": {}}) == "present"
    assert _route_after_review({}) == "present"


def test_route_after_export_allows_backfill_present_and_rerender():
    """export 后：present=补跑述标；export=重渲文件；其余收尾结束。"""
    from langgraph.graph import END
    from agent.agents.bidding_agent.graph import _route_after_export
    assert _route_after_export({"run_input": {"step": "present"}}) == "present"
    assert _route_after_export({"run_input": {"step": "export"}}) == "export"
    assert _route_after_export({"run_input": {}}) == END
    assert _route_after_export({}) == END


def test_graph_has_conditional_edges_review_to_export():
    """结构断言：review→export 与 export→present 的条件边已接入编译后的图。"""
    g = build_bidding_workflow(_FakeCtx())
    edges = {(e.source, e.target) for e in g.get_graph().edges}
    assert ("review", "export") in edges   # 跳过述标直出
    assert ("review", "present") in edges  # 缺省仍走述标
    assert ("export", "present") in edges  # 补跑述标
