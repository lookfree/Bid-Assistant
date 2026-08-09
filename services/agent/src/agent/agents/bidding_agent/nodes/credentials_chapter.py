"""资格证明文件附录 → 生成期系统章节（2026-08-09 附录系统章节设计,Plan A①）。

导出瞬间才冒出来的附录审查看不见,会把资格类要求误报"缺失"。这里把它前置成 content 步
收尾就确定性生成的一章:章内容**纯代码拼 HTML,一个字都不进模型上下文**——条目数无上限,
一旦有任何文字经过 LLM,大标书几百条证照就会把简报顶穿上下文并白白计费。占位图只带
fileId/objectKey 两个索引,不带字节:单张证照 base64 几百 KB,进 chapters 会撑爆检查点。
"""
from __future__ import annotations

import copy

SYS_CREDS_ID = "sys-creds"
# 系统章字面量——与计划 Global Constraints、App 侧 credentials-chapter.ts 逐字同形（两端
# 各自持有确定性实现,字面量一改就要同步改另一处）。items 留空数组:这一章不走提纲的
# 二级节结构,内容全在 chapters[SYS_CREDS_ID] 这段 HTML 里。
SYS_CREDS_CHAPTER = {
    "id": SYS_CREDS_ID,
    "no": "附录",
    "title": "资格证明文件",
    "group": "business",
    "system": True,
    "sourced": False,
    "items": [],
}


def _esc(text: object) -> str:
    """HTML 转义,文本节点与属性值通用。条目标题来自用户在资料库里手写,含 <>&" 会破坏
    标签结构或提前把 alt 属性闭合掉——思路照抄 web 侧 lib/image-insert.ts 的 escAttrValue,
    agent 是 Python 端,自写一份等价实现（两端各自持有确定性实现,不共用一份代码）。"""
    return (str(text or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))


def build_credentials_chapter(credentials: list[dict]) -> str:
    """资格证明文件章 HTML——每个条目一个 <h3>标题</h3>,逐图一个占位 <img>（三属性:
    data-file-id/data-object-key/alt,**无 src 无字节**),包在 <p> 里与既有章节 HTML 风格
    一致。空列表（资料库无资质条目）返回空串,调用方据此判断是否需要追加系统章。"""
    if not credentials:
        return ""
    parts: list[str] = []
    for entry in credentials:
        title = _esc(entry.get("title"))
        parts.append(f"<h3>{title}</h3>")
        for img in entry.get("images") or []:
            file_id = _esc(img.get("fileId"))
            key = _esc(img.get("key"))
            parts.append(f'<p><img data-file-id="{file_id}" data-object-key="{key}" alt="{title}" /></p>')
    return "\n".join(parts)


def _has_sys_creds(outline: dict | None) -> bool:
    return any(c.get("id") == SYS_CREDS_ID for c in (outline or {}).get("chapters", []))


def append_credentials_chapter(state: dict, chapters: dict) -> dict | None:
    """content_node 收尾触发点。run_input 有 credentials 就**无条件重建**这一章的 HTML——
    评审 2026-08-09 用代码路径实证：App 侧 state_overrides 每次触发 content 都会把库里
    outline result 回灌进图内状态，outline 带着上一次追加的 sys-creds 是**常态**而非重试
    专属的边角场景。旧版"outline/chapters 已有 sys-creds 就不动"的三查会让编辑器/审查/
    导出永远停在第一次生成时的那份旧图，用户在资料库里增删证照也追不上。

    outline 追加仍要去重（不能每次 content 收尾都在提纲里堆一条新的 sys-creds）；
    chapters[SYS_CREDS_ID] 则每次都用最新的确定性 HTML 覆盖，与用户在编辑器里删单图/
    删整章的操作无关——那些操作发生在**下一次** content 运行之前一直有效，一旦正文
    重新收尾，附录就以资料库当前状态为准（设计文档①的"重建语义"）。
    无 credentials（键缺省/空列表）→ 不动，返回 None。
    """
    credentials = (state.get("run_input") or {}).get("credentials") or []
    if not credentials:
        return None
    html = build_credentials_chapter(credentials)
    if not html:
        return None
    outline = state.get("outline") or {}
    if _has_sys_creds(outline):
        new_outline = outline                    # 已在提纲里，不重复追加
    else:
        # deepcopy:章字面量是模块级常量,浅拷贝会让多个 run 共享同一个 items 列表对象——
        # 任何一处下游误改都会串到别的 run。
        new_chapter = copy.deepcopy(SYS_CREDS_CHAPTER)
        new_outline = {**outline, "chapters": [*outline.get("chapters", []), new_chapter]}
    return {"outline": new_outline, "chapters": {**chapters, SYS_CREDS_ID: html}}
