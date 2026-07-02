def make_content_node(ctx):
    """graph 节点占位：spec203 替换为 deepagent（按章并行写 + 虚拟 FS）。"""
    async def content_node(state):
        return {"chapters": {"_stub": ""}}
    return content_node
