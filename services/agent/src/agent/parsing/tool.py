from __future__ import annotations
from langchain_core.tools import StructuredTool
from agent.parsing.service import read_and_parse


async def _parse_document(key: str) -> str:
    """解析 MinIO 上的招标文件，返回带条款 id 标注的文本（超长由调用方/压缩节点处理）。
    每条前缀 [${secId}-cN]，让模型能据此产出忠于原文的 clause_ids（前端条款定位）。"""
    doc = read_and_parse(key)
    if doc.clauses:
        return "\n".join(f"[{c['id']}] {c['text']}" for c in doc.clauses)
    return doc.text


parse_document_tool = StructuredTool.from_function(
    coroutine=_parse_document, name="parse_document",
    description="按对象存储 key 解析招标文件(docx/pdf/xlsx)为文本",
)
