def make_review_node(ctx):
    """graph 节点占位：spec204 替换为真实 create_agent + submit（废标比对 + 查重）。"""
    async def review_node(state):
        return {"risk": {"_stub": True}}
    return review_node
