from __future__ import annotations
from langchain_core.tools import StructuredTool
from agent.parsing.service import read_and_parse


async def _parse_document(key: str) -> str:
    """解析 MinIO 上的招标文件，返回纯文本（超长由调用方/压缩节点处理）。"""
    return read_and_parse(key).text


parse_document_tool = StructuredTool.from_function(
    coroutine=_parse_document, name="parse_document",
    description="按对象存储 key 解析招标文件(docx/pdf/xlsx)为文本",
)
