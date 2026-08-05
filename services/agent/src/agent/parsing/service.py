from __future__ import annotations
from agent.parsing.parsers import parse_bytes
from agent.parsing.storage_read import read_bytes
from agent.parsing.types import ParsedDoc


class DocumentUnavailable(Exception):
    """取不到文件字节（MinIO 不可达/对象暂读不到）——**瞬时**错误，值得二次机会。

    与「文件本身有问题」（加密封装/损坏/格式不支持）区分开：后者再解析一百次结果也一样。
    读标据此决定是走 parse_document 工具兜底，还是当场失败并说清原因（见 nodes/read.py）。
    """


def read_and_parse(key: str) -> ParsedDoc:
    """从 MinIO 按 key 取文件并解析（key 末段含扩展名）。

    存储侧失败包成 DocumentUnavailable，与解析侧失败（UnsupportedDocument / 各解析库的异常）
    区分开——两者对「要不要给二次机会」的答案相反。
    """
    try:
        data = read_bytes(key)
    except Exception as e:  # noqa: BLE001 存储侧任何失败都归为瞬时，由上层决定是否二次机会
        raise DocumentUnavailable(f"读取文件失败: {e}") from e
    return parse_bytes(data, key)
