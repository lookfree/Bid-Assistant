def make_outline_node(ctx):
    """graph 节点占位：spec202 替换为真实 create_agent + submit_outline。"""
    async def outline_node(state):
        return {"outline": {"_stub": True, "chapters": []}}
    return outline_node
