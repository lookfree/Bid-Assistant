"""重写闸：不许把已写完的章再写一遍，不许写提纲外的章——拒绝时告诉模型缺的是哪几章。

2026-08-08 生产实测（也是 2026-08-01 记录过的同款）：规划者的上下文被压缩后失忆，
把已完成的 b8 连写四遍、还造出幽灵章 b8_new，22 分钟烧了一万多 token，
缺的三章一个没写。循环之所以持续，是因为 write_file 每次都回它"写入成功"——
错误被确认，它就继续错。这里改成在**犯错的那一刻给纠正**：拒绝写入，
并把"哪些已完成、哪些还缺"直接写进工具回执，模型当场拿到方向。

首写放行、修复空章放行（已有内容极短视为残章，允许重写）；只拦"重写完整章"与"自创章"。
"""
from __future__ import annotations

import logging
import re

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage

from agent.framework.hooks import AgentHook  # noqa: F401  同族防护的谱系（DropMalformedToolCallsHook）

logger = logging.getLogger(__name__)

_PATH = re.compile(r"chapters/([^/\\]+?)\.html")
# 短于此的已有内容视为残章，允许重写修复——拦掉修复就把"防浪费"变成"锁死残次品"
_STUB_CHARS = 200


class RewriteGuardMiddleware(AgentMiddleware):
    def __init__(self, outline_ids: dict[str, str]) -> None:
        """outline_ids: 章 id → 标题（用于把"还缺哪些"写进回执）。"""
        super().__init__()
        self._meta = dict(outline_ids)

    def _reply(self, request: ToolCallRequest, text: str) -> ToolMessage:
        return ToolMessage(content=text, tool_call_id=(request.tool_call or {}).get("id", ""))

    async def awrap_tool_call(self, request: ToolCallRequest, handler):
        call = request.tool_call or {}
        if call.get("name") != "write_file":
            return await handler(request)
        m = _PATH.search(str((call.get("args") or {}).get("file_path", "")))
        if not m or not self._meta:
            return await handler(request)
        cid = m.group(1)
        files = (request.state or {}).get("files") or {}
        existing = ""
        for path, f in files.items():
            if _PATH.search(str(path)) and _PATH.search(str(path)).group(1) == cid:
                existing = str((f or {}).get("content", "") if isinstance(f, dict) else f)
                break
        missing = [f"{k}（{v}）" for k, v in self._meta.items()
                   if not any(_PATH.search(str(p)) and _PATH.search(str(p)).group(1) == k for p in files)]
        hint = ("；还缺的章：" + "、".join(missing[:8])) if missing else "；所有章都已写完，请直接结束"
        if cid not in self._meta:
            logger.warning("重写闸：拒绝写提纲外的章 %s", cid)
            return self._reply(request, f"「{cid}」不在提纲里，禁止自创章节，本次写入已拒绝{hint}")
        if existing and len(existing) >= _STUB_CHARS:
            logger.warning("重写闸：拒绝重写已完成的章 %s", cid)
            return self._reply(
                request, f"「{cid}」已经写完（{len(existing)} 字符），禁止重写，本次写入已拒绝{hint}")
        return await handler(request)
