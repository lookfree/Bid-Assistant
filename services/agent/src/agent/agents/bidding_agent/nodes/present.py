def make_present_node(ctx):
    """graph 节点占位：spec205 替换为真实 create_agent + submit_deck + python-pptx 渲染。"""
    async def present_node(state):
        return {"deck": {"_stub": True}}
    return present_node
