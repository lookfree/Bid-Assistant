"""资格证明文件附录 → 生成期系统章节（2026-08-09 附录系统章节设计,Plan A①）。

导出瞬间才冒出来的附录审查看不见,会把资格类要求误报"缺失"。这里把它前置成 content 步
收尾就确定性生成的一章:章内容**纯代码拼 HTML,一个字都不进模型上下文**——条目数无上限,
一旦有任何文字经过 LLM,大标书几百条证照就会把简报顶穿上下文并白白计费。占位图只带
fileId/objectKey 两个索引,不带字节:单张证照 base64 几百 KB,进 chapters 会撑爆检查点。
"""
from __future__ import annotations

import copy
import re

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


_OCR_ALT_CHARS = 120


def _image_alt(title: str, ocr_text: object) -> str:
    """占位图 alt：`标题|ocrText 截前 120 字`（无 ocrText 则纯标题），整串统一转义一次——
    与 App 侧 credentials-chapter.ts `imageAlt` 逐字节同形（终审 I-4：此前只有 cert_placement.py
    的章内插图 post-pass 带 OCR 摘要，附录章占位图仍是纯标题，两处占位图 alt 语义不该不一致；
    cert_placement.py 现从本模块导入这个函数，不再各自持有一份）。"""
    ocr = str(ocr_text or "").strip()
    label = f"{title}|{ocr[:_OCR_ALT_CHARS]}" if ocr else title
    return _esc(label)


def build_credentials_chapter(credentials: list[dict]) -> str:
    """资格证明文件章 HTML——每个条目一个 <h3>标题</h3>,逐图一个占位 <img>（三属性:
    data-file-id/data-object-key/alt,**无 src 无字节**),包在 <p> 里与既有章节 HTML 风格
    一致。alt 带 OCR 摘要（终审 I-4，与章内证照 post-pass 同形）。空列表（资料库无资质
    条目）返回空串,调用方据此判断是否需要追加系统章。"""
    if not credentials:
        return ""
    parts: list[str] = []
    for entry in credentials:
        raw_title = str(entry.get("title") or "")
        title = _esc(raw_title)
        parts.append(f"<h3>{title}</h3>")
        for img in entry.get("images") or []:
            file_id = _esc(img.get("fileId"))
            key = _esc(img.get("key"))
            alt = _image_alt(raw_title, img.get("ocrText"))
            parts.append(f'<p><img data-file-id="{file_id}" data-object-key="{key}" alt="{alt}" /></p>')
    return "\n".join(parts)


def _has_sys_creds(outline: dict | None) -> bool:
    return any(c.get("id") == SYS_CREDS_ID for c in (outline or {}).get("chapters", []))


_FILE_ID_RE = re.compile(r'data-file-id="([^"]+)"')
_ALL_PLACED_NOTE = "<p>（各项资格证明材料已插入对应正文章节，见目录。）</p>"


def _placed_file_ids(chapters: dict) -> set[str]:
    """正文各章（不含附录自己）已出现的占位图 fileId——cert_placement 的锚点就位/章尾
    追加都以 `data-file-id` 落图，据此判断哪些材料已经进了正文。墓碑章（None）跳过。"""
    return {fid for cid, html in (chapters or {}).items() if cid != SYS_CREDS_ID
            for fid in _FILE_ID_RE.findall(html or "")}


def _unplaced(credentials: list[dict], placed_ids: set[str]) -> list[dict]:
    """还没进正文的条目。**全部**图都已就位才算已安置——部分就位的条目整条保留在附录，
    宁可多一份也不能让剩下的图无处可寻（2026-08-12 用户口径：图要在对应章节，附录只
    收没去处的）。无图条目谈不上就位，恒留附录。"""
    def settled(entry: dict) -> bool:
        imgs = entry.get("images") or []
        return bool(imgs) and all(str(i.get("fileId") or "") in placed_ids for i in imgs)
    return [c for c in credentials if not settled(c)]


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
    outline = state.get("outline") or {}
    # 附录只收**没去处**的材料（2026-08-12 云上江西用户反馈「都放到附录里面了」）：
    # cert_placement 已把对得上号的图插进对应章/小节，这里按正文里的 data-file-id 反查，
    # 已就位的条目不再进附录重复一遍。
    html = build_credentials_chapter(_unplaced(credentials, _placed_file_ids(chapters)))
    if not html:
        if _has_sys_creds(outline):
            # 重跑：附录章已在提纲里删不掉（用户可能编辑过它周边），给一行说明，
            # 不能留空章——空 html 会被渲染成「（本章正文待生成）」
            return {"outline": outline, "chapters": {**chapters, SYS_CREDS_ID: _ALL_PLACED_NOTE}}
        return None
    if _has_sys_creds(outline):
        new_outline = outline                    # 已在提纲里，不重复追加
    else:
        # deepcopy:章字面量是模块级常量,浅拷贝会让多个 run 共享同一个 items 列表对象——
        # 任何一处下游误改都会串到别的 run。
        new_chapter = copy.deepcopy(SYS_CREDS_CHAPTER)
        new_outline = {**outline, "chapters": [*outline.get("chapters", []), new_chapter]}
    return {"outline": new_outline, "chapters": {**chapters, SYS_CREDS_ID: html}}
