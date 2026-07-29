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


def test_route_entry_and_after_read_for_standalone_review():
    """spec328 独立审查：新线程 step=review 直接进 review；read 后 step=review 跳过 outline/content。"""
    from agent.agents.bidding_agent.graph import _route_entry, _route_after_read
    assert _route_entry({"run_input": {"step": "review"}}) == "review"
    assert _route_entry({"run_input": {"step": "read"}}) == "read"
    assert _route_entry({}) == "read"
    assert _route_after_read({"run_input": {"step": "review"}}) == "review"
    assert _route_after_read({"run_input": {"step": "outline"}}) == "outline"
    assert _route_after_read({}) == "outline"


def test_route_entry_and_after_read_for_standalone_present():
    """独立述标（线下标书，与独立审查同一机制）：新线程 step=present 直接进 present（无招标文件也能
    述标）；read 后 step=present 同样跳过 outline/content 直达 present（有招标文件先读标再述标）。"""
    from agent.agents.bidding_agent.graph import _route_entry, _route_after_read
    assert _route_entry({"run_input": {"step": "present"}}) == "present"
    assert _route_after_read({"run_input": {"step": "present"}}) == "present"


def test_graph_has_standalone_review_edges():
    g = build_bidding_workflow(_FakeCtx())
    edges = {(e.source, e.target) for e in g.get_graph().edges}
    assert ("__start__", "review") in edges  # 无招标文件直接审查
    assert ("read", "review") in edges       # 对照审查跳过提纲/正文
    assert ("read", "outline") in edges      # 缺省流水线不变


def test_graph_has_standalone_present_edges():
    g = build_bidding_workflow(_FakeCtx())
    edges = {(e.source, e.target) for e in g.get_graph().edges}
    assert ("__start__", "present") in edges  # 无招标文件直接述标（线下标书）
    assert ("read", "present") in edges       # 有招标文件先读标，读完直达述标（跳过提纲/正文/审查）


def test_content_routes_to_export_when_review_is_skipped():
    """跳过废标体检直出（用户口径「体检 60 积分，不想查的不该被强收」）：
    content 之后的出边必须是**条件边**——写成静态边时，停在 content 的检查点无论请求哪一步
    都会先跑 review 节点：用户点的是导出，实跑的是一轮审查大模型，产物写成 export 步结果、
    导出费照扣、docx 根本没渲染（评审用真实 langgraph 复现过）。"""
    from agent.agents.bidding_agent.graph import _route_after_content, _route_after_export

    assert _route_after_content({"run_input": {"step": "export"}}) == "export"
    assert _route_after_content({"run_input": {"step": "present"}}) == "present"  # 述标同样不依赖体检
    assert _route_after_content({"run_input": {"step": "review"}}) == "review"
    assert _route_after_content({}) == "review"          # 未指定=按流水线正常走体检
    # 跳过体检直出的项目事后仍要能补跑体检，否则那个项目的废标体检永远买不到
    assert _route_after_export({"run_input": {"step": "review"}}) == "review"
