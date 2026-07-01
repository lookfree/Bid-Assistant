from __future__ import annotations
from agent.parsing.parsers import parse_bytes
from agent.parsing.storage_read import read_bytes
from agent.parsing.types import ParsedDoc


def read_and_parse(key: str) -> ParsedDoc:
    """从 MinIO 按 key 取文件并解析（key 末段含扩展名）。"""
    data = read_bytes(key)
    return parse_bytes(data, key)
