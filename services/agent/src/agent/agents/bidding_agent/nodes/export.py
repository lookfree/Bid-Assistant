def make_export_node(ctx):
    """graph 节点占位：spec206 替换为普通服务节点（chapters + 提纲 → .docx，无 LLM）。"""
    async def export_node(state):
        return {"artifacts": {"docx": "_stub"}}
    return export_node
