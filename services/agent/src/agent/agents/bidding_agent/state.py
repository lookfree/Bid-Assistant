from __future__ import annotations
from typing import Annotated, Any, TypedDict


def _merge_dict(a: dict | None, b: dict | None) -> dict:
    return {**(a or {}), **(b or {})}


class BiddingState(TypedDict, total=False):
    """投标工作流贯穿状态：一本标书一个 thread_id，靠 checkpointer 续（§4.7）。
    各节点在自己的 create_agent 子图内持有消息，父图只透传结构化产物，故无 messages 通道。"""
    file_key: str                  # 招标文件 MinIO key（首个文件，向后兼容单文件调用方）
    files: list[dict[str, str]]    # [{key, name}, ...] 多份招标文件（spec320）；缺省时走 file_key 单文件路径不变
    run_input: dict[str, Any]      # 本 run 参数（duration/template…），每 run 整通道覆盖（spec315a）
    # 招标原文条款分句 doc_sections 不设独立通道：只并入 read result（唯一消费方是前端左栏），双份落地徒增 checkpoint 体积
    read: dict[str, Any]           # ReadResult.model_dump()（含 doc_sections） ← read（spec107/315a）
    outline: dict[str, Any]        # Outline.model_dump()         ← outline（spec202）
    # {chapter_id: body_html} ← content（spec203）。合并 reducer：单章改写只更新一章不覆盖全量；
    # content 全量生成返回完整 dict，merge 后语义不变。outline 删章留下的孤儿 key 无害——
    # render_docx 按 outline 章节遍历取稿，孤儿章天然被忽略。
    chapters: Annotated[dict[str, str], _merge_dict]
    risk: dict[str, Any]           # RiskReport.model_dump()      ← review（spec204）
    deck: dict[str, Any]           # DeckSpec.model_dump()        ← present（spec205）
    # {"docx": key, "pptx": key} ← export/present（spec205/206）；合并 reducer 让二者并存
    artifacts: Annotated[dict[str, str], _merge_dict]
