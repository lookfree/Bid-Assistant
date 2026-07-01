from __future__ import annotations

from pydantic import BaseModel
from langchain_core.tools import StructuredTool


def make_submit_tool(name: str, schema: type[BaseModel], description: str):
    """生成一个"结构化提交"工具：模型按 schema 调用 → 强校验 → 捕获结果。
    返回 (tool, get_last)。配 force tool_choice 即可强约束模型按 schema 产出（DeckSpec/读标结果等）。"""
    captured: dict = {}

    async def _submit(**kwargs) -> str:
        obj = schema(**kwargs)         # Pydantic 校验，不合法即抛
        captured["value"] = obj
        return f"{name} accepted"

    tool = StructuredTool.from_function(coroutine=_submit, name=name, description=description, args_schema=schema)

    def get_last() -> BaseModel | None:
        return captured.get("value")

    return tool, get_last
