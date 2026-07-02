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
