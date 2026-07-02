from __future__ import annotations
import json
from deepagents import create_deep_agent          # 全流程唯一 deepagent 节点（§4.5）
from langchain_core.messages import HumanMessage
from agent.models.usage import UsageCallback
from agent.agents.bidding_agent.prompts.content import CONTENT_PLANNER_PROMPT, CHAPTER_WRITER_PROMPT

_CHAPTER_PREFIX = "/chapters/"


def _collect_chapters(files: dict | None) -> dict[str, str]:
    """从 deepagent 虚拟 FS 结果（v2：{path: {content,...}}，路径带前导斜杠）按前缀收稿。"""
    chapters: dict[str, str] = {}
    for path, data in (files or {}).items():
        norm = path if path.startswith("/") else f"/{path}"
        if not norm.startswith(_CHAPTER_PREFIX):
            continue
        cid = norm[len(_CHAPTER_PREFIX):].removesuffix(".html")
        chapters[cid] = data["content"] if isinstance(data, dict) else str(data)
    return chapters


def make_content_node(ctx):
    """deepagent 节点：主控规划（todos）→ 按章派子写手 → 虚拟 FS 收稿 → state['chapters']。
    上下文压缩用 deepagents 内建 summarization middleware（长标书防超窗）；
    虚拟 FS 是默认 StateBackend、不开 execute；一章未产出即失败（run failed 可重试）。"""
    async def content_node(state):
        model = ctx.gateway.get_chat(provider=None) if ctx.gateway else None
        deep = create_deep_agent(
            model=model, tools=[], system_prompt=CONTENT_PLANNER_PROMPT,
            subagents=[{"name": "chapter_writer", "description": "写指定一章的标书正文 HTML",
                        "system_prompt": CHAPTER_WRITER_PROMPT}],
        )
        user = (f"提纲：\n{json.dumps(state.get('outline', {}), ensure_ascii=False)}\n\n"
                f"读标依据：\n{json.dumps(state.get('read', {}), ensure_ascii=False)}\n\n"
                f"请逐章生成正文，每章写入 chapters/<章id>.html。")
        # recursion_limit 放宽：10 章 ×（task 派发 + write_file）远超默认 25 步；
        # UsageCallback 补记 token（deepagent 直驱模型，不经 make_agent_node 埋点）。
        res = await deep.ainvoke(
            {"messages": [HumanMessage(content=user)]},
            config={"recursion_limit": 100, "callbacks": [UsageCallback(ctx, "content")]})
        chapters = _collect_chapters(res.get("files"))
        if not chapters:
            raise RuntimeError("deepagent 未产出任何章节草稿（chapters/*.html）")
        return {"chapters": chapters}
    return content_node
