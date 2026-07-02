from __future__ import annotations
import json
from deepagents import create_deep_agent          # 全流程唯一 deepagent 节点（§4.5）
from langchain_core.messages import HumanMessage
from agent.models.usage import UsageCallback
from agent.framework.create_agent import build_create_agent
from agent.agents.bidding_agent.prompts.content import (
    CONTENT_PLANNER_PROMPT, CHAPTER_WRITER_PROMPT, REWRITE_PROMPT)

_CHAPTER_PREFIX = "/chapters/"


def _collect_chapters(files: dict | None) -> dict[str, str]:
    """从 deepagent 虚拟 FS 结果（v2：{path: {content,...}}，路径带前导斜杠）按前缀收稿。"""
    chapters: dict[str, str] = {}
    for path, data in (files or {}).items():
        norm = path if path.startswith("/") else f"/{path}"
        if not norm.startswith(_CHAPTER_PREFIX):
            continue
        cid = norm[len(_CHAPTER_PREFIX):].removesuffix(".html")
        # content 允许缺省（deepagents 自身也按可缺处理）；空稿跳过——全空最终触发 fail-loud
        content = data.get("content", "") if isinstance(data, dict) else str(data)
        if content:
            chapters[cid] = content
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


async def rewrite_chapter(ctx, chapter_id: str, instruction: str, state: dict) -> str:
    """单章改写（/content 右栏 AI 对话）：原章 HTML + 用户指令 → 新 HTML。走轻量 create_agent，不重规划全本。
    state 传工作流状态**值 dict**（如 `(await graph.aget_state(cfg)).values`），不是 StateSnapshot 本身。"""
    old = state.get("chapters", {}).get(chapter_id, "")
    sub = build_create_agent(REWRITE_PROMPT, [], ctx)
    msg = f"原章 HTML：\n{old}\n\n改写指令：{instruction}"
    out = await sub.ainvoke({"messages": [HumanMessage(content=msg)]})
    return out["messages"][-1].content
