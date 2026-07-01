from __future__ import annotations

from typing import Protocol
from langchain_core.tools import StructuredTool


class Backend(Protocol):
    async def read_file(self, path: str) -> str: ...
    async def write_file(self, path: str, content: str) -> None: ...
    async def edit_file(self, path: str, old_str: str, new_str: str) -> str: ...
    async def list_files(self, path: str = "/") -> list[str]: ...
    async def grep(self, pattern: str, path: str = "/") -> list[str]: ...


class InStateBackend:
    """默认后端：内存虚拟文件系统（按 run 实例化；可由 BaseAgent 与 state 同步）。"""
    def __init__(self, files: dict[str, str] | None = None):
        self._files = dict(files or {})

    async def read_file(self, path: str) -> str:
        if path not in self._files:
            raise FileNotFoundError(path)
        return self._files[path]

    async def write_file(self, path: str, content: str) -> None:
        self._files[path] = content

    async def edit_file(self, path: str, old_str: str, new_str: str) -> str:
        cur = await self.read_file(path)
        if old_str not in cur:
            raise ValueError(f"old_str not found in {path}")
        self._files[path] = cur.replace(old_str, new_str, 1)
        return self._files[path]

    async def list_files(self, path: str = "/") -> list[str]:
        return sorted(self._files.keys())

    async def grep(self, pattern: str, path: str = "/") -> list[str]:
        return [p for p, c in self._files.items() if pattern in c]

    def snapshot(self) -> dict[str, str]:
        return dict(self._files)


def create_backend_tools(backend: Backend, *, allow_execute: bool = False) -> list:
    """把 backend 长出文件工具（execute 默认不开，§4.5）。"""
    async def read_file(path: str) -> str:
        return await backend.read_file(path)

    async def write_file(path: str, content: str) -> str:
        await backend.write_file(path, content)
        return f"written {path}"

    async def edit_file(path: str, old_str: str, new_str: str) -> str:
        return await backend.edit_file(path, old_str, new_str)

    async def list_files(path: str = "/") -> str:
        return "\n".join(await backend.list_files(path))

    tools = [
        StructuredTool.from_function(coroutine=read_file, name="read_file", description="读取虚拟文件"),
        StructuredTool.from_function(coroutine=write_file, name="write_file", description="写入虚拟文件"),
        StructuredTool.from_function(coroutine=edit_file, name="edit_file", description="按字符串替换编辑文件"),
        StructuredTool.from_function(coroutine=list_files, name="list_files", description="列出文件"),
    ]
    # allow_execute=True 时才接入 shell 后端（需 OpenSandbox，§4.5）；本框架默认不开。
    return tools
