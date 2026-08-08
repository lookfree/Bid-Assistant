from __future__ import annotations

import asyncio
import logging
import re
from html import unescape

from agent.framework.budget import chapter_budget
from agent.parsing import storage_read
from agent.parsing.service import read_and_parse
from agent.parsing.storage_read import storage      # spec106 MinIO 单例
from agent.runtime.progress import publish_phase     # 各节点推阶段事件（read/outline/review/present 共用）

logger = logging.getLogger(__name__)

__all__ = ["publish_phase", "upload_artifact", "fetch_master_bytes", "package_scope",
           "filter_read_by_package", "slim_read", "parse_bid_chapters", "html_to_review_text",
           "allocate_chapter_budget", "chapters_budget", "MIN_CHAPTER_CHARS"]


def parse_bid_chapters(keys: str | list[str]) -> dict[str, str]:
    """线下标书 → chapters（spec328 独立审查 / 独立述标共用）：确定性解析,按节聚合成 {sec-N: html}。
    无 LLM、不计费;解析失败抛错由节点层转 run 失败（App 侧退款）。review/present 两节点共用——
    没有 state['chapters']（没跑过 content）时,靠 run_input 里的标书文件兜底解析出正文。

    收多份文件（商务标与技术标常常分册出卷）：按传入顺序逐份解析再拼接。**节号必须全局重排**——
    每份文件的节号都从 sec-1 起,直接合并会让后一份把前一份的同号节整节覆盖（静默丢半本标书）。"""
    out: dict[str, str] = {}
    for key in [keys] if isinstance(keys, str) else keys:
        parsed = read_and_parse(key)
        by_sec: dict[str, list[str]] = {}
        for c in parsed.clauses:
            m = re.match(r"^(sec-\d+)-", c.get("id") or "")
            if m:
                by_sec.setdefault(m.group(1), []).append(c.get("text") or "")
        for texts in by_sec.values():
            html = "".join(f"<p>{t}</p>" for t in texts if t)
            if html:
                out[f"sec-{len(out) + 1}"] = html
    return out


async def upload_artifact(ctx, filename: str, data: bytes, content_type: str) -> str:
    """终产物统一落 MinIO：artifacts/<thread_id>/<filename>，返回 key。present/export 共用。"""
    key = f"artifacts/{ctx.thread_id}/{filename}"
    await storage.put_bytes(key, data, content_type=content_type)
    return key


async def fetch_master_bytes(key: str | None) -> bytes | None:
    """企业自有 .pptx/.potx 母版按 MinIO key 预取字节；present（首渲）/export（重渲）共用。
    缺 key 或取失败（网络抖动/坏 key/未上传）→ 记警告日志并回 None——render_pptx 自身在母版
    加载/渲染失败时也会回退空白设计，这里再兜一层，双保险不阻断述标/导出产出。"""
    if not key:
        return None
    try:
        return await asyncio.to_thread(storage_read.read_bytes, key)
    except Exception:
        logger.warning("企业母版拉取失败 key=%s", key, exc_info=True)
        return None


def package_scope(run_input: dict | None) -> str:
    """run_input.package 存在时的范围约束文本（spec324）：outline/content 共用，追加在用户
    消息末尾；未选包（缺省）时返回空串，用户消息与此前逐字节一致。"""
    package = (run_input or {}).get("package") or {}
    if not package:
        return ""
    name = package.get("name", "")
    pid = package.get("id", "")
    return (f"\n本项目仅投包件《{name}》({pid})：提纲/正文仅覆盖该包件的需求、评分与构成，"
            "其它包件内容一律忽略；涉及分包件评分表/偏离表仅取该包件。")


def _pkg_id(run_input: dict | None) -> str | None:
    return ((run_input or {}).get("package") or {}).get("id") or None


def filter_read_by_package(read: dict, run_input: dict | None) -> dict:
    """选包时把读标结论收窄到该包(spec324 上下文优化):保留 packages 为空(全包通用)或含所选包 id 的条目,
    别的包专属条目丢弃——喂给 LLM 的上下文从「全部包」缩到「单包」,大标书速度/成本降 2-3 倍。
    未选包(单包/缺省) → 原样返回,行为逐字节不变。categories.items / scoring / required_structure 三处过滤。"""
    pid = _pkg_id(run_input)
    if not pid:
        return read

    def keep(it: dict) -> bool:
        pk = it.get("packages") or []
        return not pk or pid in pk

    out = dict(read)
    out["categories"] = [{**c, "items": [i for i in c.get("items", []) if keep(i)]}
                         for c in read.get("categories", [])]
    out["scoring"] = [s for s in read.get("scoring", []) if keep(s)]
    if "required_structure" in read:
        out["required_structure"] = [s for s in read.get("required_structure", []) if keep(s)]
    return out


def slim_read(read: dict) -> dict:
    """白名单出下游提示词需要的读标字段（项目信息/分类/评分表/红线），
    并裁掉 source_quote（原文摘录，token 大头）。outline / review 共用。"""
    cats = [{**c, "items": [{k: v for k, v in it.items() if k != "source_quote"}
                            for it in c.get("items", [])]}
            for c in read.get("categories", [])]
    return {"project_meta": read.get("project_meta", {}), "categories": cats,
            "scoring": read.get("scoring", []), "risk_summary": read.get("risk_summary", [])}


# 正文里内联的图片：`<img src="data:image/jpeg;base64,……">`，单张就有二十万字符。
# 审查每章只喂前 4000 字符，图片一出现，后面的正文一个字都进不了模型——用户把营业执照
# 以图片形式放进正文，审查却报「缺少该材料」（2026-08-06 用户反馈，230 实测坐实）。
# 喂模型/扫描之前一律换成短占位符：既不吃截断预算，也让模型知道这里确实有一张图。
# **只用于构造模型输入**；存库与导出仍保留真图。
_IMG_RE = re.compile(r"<img\b[^>]*>", re.I | re.S)
_ALT_RE = re.compile(r'\balt\s*=\s*["\']([^"\']*)["\']', re.I)
_GENERIC_ALT = {"", "插图", "图片", "image", "img"}


def strip_inline_images(html: str | None) -> str:
    """把 <img …> 换成 ［图片：alt］。alt 是默认值（插图）时只留「［图片］」——重复没有信息量。"""
    if not html:
        return ""

    def _sub(m: re.Match) -> str:
        alt = (_ALT_RE.search(m.group(0)) or [None, ""])[1] if _ALT_RE.search(m.group(0)) else ""
        alt = (alt or "").strip()
        return f"［图片：{alt}］" if alt and alt.lower() not in _GENERIC_ALT else "［图片］"

    return _IMG_RE.sub(_sub, html)


# 单章保底：再多的章也要让每章有点内容，否则等于没看
MIN_CHAPTER_CHARS = 1_000


def chapters_budget(ctx, fixed_text: str) -> int:
    """本次调用留给正文的额度（字符），review / present 共用。

    额度 = 模型窗口 − 输出配额 − fixed_text（系统提示 + 读标结论 + 各类约束）− schema − 余量。
    **不写死常量**：读标结论的大小随招标文件浮动（实测中位 17810 tokens、最大 197002），
    固定值要么砍不够照样 400，要么砍过头——中位项目本来放得下 4.7 万 tokens 的正文。

    窗口取运营后台下发的 model_context_window；没配置时 budget 侧兜底 131072。
    token 估算按中文 1 字 1 token（实测 0.87，留 15% 余量），故额度直接当字符数用。
    """
    s = getattr(ctx.gateway, "s", None)
    return chapter_budget(fixed_text,
                          context_window=getattr(s, "model_context_window", None),
                          max_tokens=getattr(s, "model_max_tokens", None))


def allocate_chapter_budget(texts: dict[str, str], total: int, floor: int) -> dict[str, str]:
    """在总量上限内给各章分配可喂给模型的字数。

    **为什么不是"每章固定上限"**：那个口径对线下标书是灾难——上传的标书常常整本解析成一章。
    2026-08-07 实测一份 75425 字的响应文件只解析出 1 章，按每章 4000 字截断后模型只看到 5%，
    剩下 95% 的内容全被判成"缺失"，用户拿到一堆"实际文件里都有"的假风险。

    分配用注水法：短章按原样全给（它们占不满份额），省下的额度自动匀给长章。
    这样 1 章的文档能整本进去，多章文档也不会因为某一章特别长就把别人挤没。
    截断处补「…（截断）」，让模型知道后面还有，而不是当成写完了。
    """
    if not texts:
        return {}
    remaining, out = total, {}
    pending = dict(texts)
    while pending:
        share = max(floor, remaining // len(pending))
        short = {k: v for k, v in pending.items() if len(v) <= share}
        if not short:                       # 剩下的都超额：按当前份额一刀切
            for k, v in pending.items():
                out[k] = v[:share] + "…（截断）"
            break
        for k, v in short.items():          # 短章全给，把省下的额度让给长章
            out[k] = v
            remaining -= len(v)
            pending.pop(k)
    return out


_CELL_END = re.compile(r"</(?:td|th)\s*>", re.I)
_BLOCK_END = re.compile(r"</(?:p|div|h[1-6]|li|tr|table|thead|tbody|blockquote)\s*>", re.I)
_ANY_TAG = re.compile(r"<[^>]+>")


def html_to_review_text(html: str | None) -> str:
    """章节 HTML → 喂给审查模型的紧凑文本。

    审查按章截断（_CHAPTER_CAP），而**标签同样占额度**：2026-08-07 全量实测，喂进去的
    2066168 字符里只有 924829 是正文，**56% 花在 HTML 标签上**。表格类章节尤其离谱——
    有一章正文才 5261 字、本来完全放得下 4000 的额度，却因为 <td>/<tr> 把串撑到 38431，
    模型只读到 561 字（10%）。不是章节太长，是额度被标签吃了。

    只剥不改结构：单元格之间留 " | "、行与段落留换行——审查要靠表格行判断
    「★条款有没有逐条登进偏离表」，把表格压成一坨连续文字就查不出来了。
    """
    s = strip_inline_images(html)          # 必须先做：图片要留下 alt（证照识别文字在里面）
    s = _CELL_END.sub(" | ", s)
    s = _BLOCK_END.sub("\n", s)
    s = _ANY_TAG.sub("", s)
    s = unescape(s)                        # &nbsp;/&amp; 一个实体就占 5–6 字符，表格里成片出现
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" *\n[\s\n]*", "\n", s)
    return s.strip()


# 单章 AI 改写：原章 HTML 整个喂给模型、再用模型输出**整章替换**。内联图片是 base64
# （实测单张 20 万字符），模型既读不懂也不可能原样吐回——一次改写，用户放进正文的营业执照
# 就没了。这不是"识别不到"，是数据丢失。故喂之前换成短标记、拿回输出后再换回原标签。
_MARKER_RE = re.compile(r"［图片(\d+)[^］]*］")


def protect_images(html: str | None) -> tuple[str, dict[int, str]]:
    """<img …> → ［图片N：alt］，并返回 N → 原始标签。标记带 alt，模型才知道这里是什么、不该删。"""
    keep: dict[int, str] = {}
    if not html:
        return "", keep

    def _sub(m: re.Match) -> str:
        n = len(keep) + 1
        keep[n] = m.group(0)
        alt = (_ALT_RE.search(m.group(0)) or [None, ""])[1] if _ALT_RE.search(m.group(0)) else ""
        alt = (alt or "").strip()
        return f"［图片{n}：{alt}］" if alt else f"［图片{n}］"

    return _IMG_RE.sub(_sub, html), keep


def restore_images(html: str, keep: dict[int, str]) -> str:
    """把标记换回原始 <img>。模型漏写的标记，其图片补到末尾——
    位置不完美用户还能挪，凭空消失则是把人家的证照弄丢了。"""
    if not keep:
        return html
    used: set[int] = set()

    def _sub(m: re.Match) -> str:
        n = int(m.group(1))
        tag = keep.get(n)
        if tag is None:
            return m.group(0)   # 模型自己编的编号，原样留着，别吞用户文字
        used.add(n)
        return tag

    out = _MARKER_RE.sub(_sub, html)
    missing = [keep[n] for n in sorted(keep) if n not in used]
    return out + "".join(missing)
