from __future__ import annotations
import asyncio
import hashlib
import json
import logging
from agent.config import settings
from agent.framework.create_agent import run_submit_agent
from agent.parsing.service import read_and_parse, DocumentUnavailable
from agent.parsing.types import UnsupportedDocument
from agent.parsing.merge import merge_parsed
from agent.parsing.tool import parse_document_tool
from agent.agents.bidding_agent.schemas import ReadResult, ReadCategory
from agent.agents.bidding_agent.nodes.common import publish_phase
from agent.runtime.progress import publish_event
from agent.agents.bidding_agent.nodes.classify import classify_from_read
from agent.agents.bidding_agent.prompts.read import READ_SYSTEM_PROMPT
from agent.db import get_pool
from agent.rag import store as rag_store
from agent.rag import retrieve as rag_retrieve

logger = logging.getLogger(__name__)

# 后台索引任务引用集:create_task 的返回若不持引用会被 GC 回收→任务悄然取消(Python 官方文档警告)。
_BG_INDEX_TASKS: set = set()

# 分段读标阈值：条款数超过此值时,完整 ReadResult(逐条 technical)必然顶穿模型 8k 输出上限
# (南瑞 4 文件标实测:两轮压缩重试仍 length 截断)——拆多轮提交,节点内合并。
SEGMENT_CLAUSE_THRESHOLD = 200
# 技术项逐块提取:每块覆盖的条款数上限。多包件标(如 3 包网络攻防)技术需求逐条累加会超 8k 输出,
# 按条款分块、每块只提本块技术项,块数随标书规模线性增长,单块输出恒有界。
TECH_CHUNK_CLAUSES = 100

# 骨架也拆细:多包件标(3包/4包)非技术部分(3份评分表 + 32项构成 + 各类别)单轮同样超 8k 输出。
# 每轮限定字段范围,配合技术分块,任何规模标书单轮输出都恒有界。
_SEG_BASE = ("\n\n本轮为分段提交·基础轮:只填 project_meta,以及 categories 中的 "
             "overview/qualification/commercial 三类;其余字段一律空值/空列表(scoring/format/"
             "technical/required_structure/packages 都后续轮次单独提交)。")
_SEG_FMT = ("\n\n本轮为分段提交·格式构成轮:只填 categories 中的 format 一类,以及 "
            "required_structure、packages、risk_summary;其余字段一律空值/空列表。")
_SEG_SCORE = ("\n\n本轮为分段提交·评分轮:只填 scoring(评分办法表逐行,多包件则各包评分逐行);"
              "categories 一律空、其余字段空。若为最低价法/无技术打分,scoring 留空即可。")


def _tech_chunk_user(chunk: list[dict], idx: int, total: int) -> str:
    """技术分块轮的**独立**用户消息:只喂本块条款,不再携带全文——此前每块都把整份标书塞进
    prompt(92 块 = 全文重复 92 次),1MB 标书实测单轮 prefill ~4 分钟、输入 token 重复计费近百次。
    条款分句自带稳定锚点 id(clause_ids 直接引用),提取本块技术项不需要全局上下文;
    代价是块内条款若缺"包件X"节标题,technical 项的 packages 标签可能漏标——漏标=空=全包通用,
    下游过滤只会多保留、不会丢需求(安全方向)。骨架三轮(基础/格式/评分)仍喂全文(真需全局视野)。"""
    return (f"本轮为分段提交·技术第 {idx}/{total} 块:categories 只含 technical 一类,"
            f"且只提取下列这批条款覆盖的技术需求(逐条,带★/▲必须单列);其余字段一律空值/空列表。\n"
            f"每个技术项的 packages 字段一律留空数组(本轮只见部分条款、看不到全局包件表,"
            f"禁止猜测包件归属;留空=全包通用,后续选包过滤只会多保留不会丢)。\n"
            f"条款已解析为分句(id 为稳定锚点,clause_ids 直接引用,无需再调 parse_document):\n"
            f"{json.dumps(chunk, ensure_ascii=False)}\n\n请读标。")


async def _seg_submit(ctx, user: str, hint: str, label: str) -> ReadResult:
    return await run_submit_agent(
        ctx, READ_SYSTEM_PROMPT, user + hint, "submit_read_result", ReadResult, label)


# 分段读标并发上限:各轮彼此独立(不同字段/不同条款块),并发跑墙钟≈最慢一批而非累加
# (三包 2100 条款标实测:24 轮串行 ~16 分钟 → 并发后 ~2-3 分钟)。上限防服务商限流。
SEG_CONCURRENCY = 6

# 分段轮结果缓存(断点续跑):每轮成功即按 thread_id+轮id+输入哈希 存 Redis,重试时命中直接跳过,
# 只重跑没完成的轮——92 块标书在 14/95 处失败重试,不再把已花的几十轮 token 全部重烧(生产实测之痛)。
# 输入哈希保证换文件/条款变化即失效;TTL 24h(重试窗口足够,过期自动清)。
_SEG_CACHE_TTL_S = 24 * 3600


# 提示词版本指纹:系统提示词变更(抽取规则变化)后,旧缓存轮与新规则轮混合会产出任何代码版本
# 都不会生成的"混血"结果——把提示词哈希折进缓存键,发版改提示词即自动全量失效。
_PROMPT_VER = hashlib.sha256(READ_SYSTEM_PROMPT.encode("utf-8")).hexdigest()[:8]


def _seg_cache_key(ctx, round_id: str, payload: str) -> str:
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"{settings.redis_prefix}segread:{ctx.thread_id}:{round_id}:{_PROMPT_VER}:{digest}"


async def _seg_cache_get(ctx, key: str) -> ReadResult | None:
    """best-effort 读缓存:无 redis/读失败/反序列化失败都回 None(照常跑模型),绝不影响主流程。"""
    r = getattr(ctx, "redis", None)
    if not r:
        return None
    try:
        raw = await asyncio.to_thread(r.get, key)
        return ReadResult.model_validate_json(raw) if raw else None
    except Exception:  # noqa: BLE001
        logger.warning("segread cache get failed key=%s", key, exc_info=True)
        return None


async def _seg_cache_set(ctx, key: str, part: ReadResult) -> None:
    """best-effort 写缓存:失败只记警告,不影响该轮结果交付。"""
    r = getattr(ctx, "redis", None)
    if not r:
        return
    try:
        await asyncio.to_thread(r.set, key, part.model_dump_json(), ex=_SEG_CACHE_TTL_S)
    except Exception:  # noqa: BLE001
        logger.warning("segread cache set failed key=%s", key, exc_info=True)



# 单轮推送的条目上限：控的是**单条事件的体积**（几十条中文条目已是几十 KB，经 Redis→API 中继→
# 浏览器，且每次重连都整段回放）。注意不是为了防流被挤爆——xadd 的 maxlen 按**条数**截断，
# 与单条大小无关，一次分段读标最多 ~2N 条，离 1000 很远。
_PART_ITEMS_CAP = 60

# 展示态只需要这两样：页面拿分轮产出**只渲染「分类解读」那一栏**（评分表/构成清单/包件都等最终
# 结果）。多推的字段一路走到浏览器再被丢掉，纯属白占带宽，重连时还要整段重放。
_PART_DROP_ITEM_FIELDS = (
    "source_quote",   # 体积大头，前端本就按 clause_ids 回看原文
    "packages",       # 分块轮看不到全局包件表，模型猜的标签在最终合并处才被强制清空
                      # （见 _segmented_read）——展示态提前泄露未净化的标签，正是「选包过滤
                      # 静默丢 ★ 需求」那类事故的输入，这里同样不外传。
)


def _slim_part(part: ReadResult) -> dict:
    """把一轮的产出裁成「能直接上屏」的展示态：只留 project_meta 与 categories，
    条目去掉体积大头与未净化字段，并按上限截断。"""
    cats = [{"key": c.key, "title": c.title,
             "items": [{k: v for k, v in it.model_dump().items() if k not in _PART_DROP_ITEM_FIELDS}
                       for it in c.items[:_PART_ITEMS_CAP]]}
            for c in part.categories if c.items]
    out: dict = {}
    if part.project_meta:
        out["project_meta"] = part.project_meta
    if cats:
        out["categories"] = cats
    return out


# 原文分片推送：条款是**模型跑之前**就确定性解析好的，没理由让左栏「原文」空等十几分钟。
# 分片是因为整份推会撑爆单条事件（9000 条款标≈1MB），且每次重连都要整段回放。
_SECTIONS_CHUNK = 300
_SECTIONS_CAP = 3000   # 超大标只先推前 3000 条，够左栏定位用；完整全文随 step.done 一次到位


async def _publish_sections(ctx, clauses: list[dict], headings: list[dict]) -> None:
    """把已解析的条款分片推给前端，让左栏原文立刻可读、右栏流式出来的条目立刻可定位。
    章节标题随第一片一起过去（体量小），左栏一开始就有层级而不是「第N部分」。
    best-effort：推送失败绝不影响读标。"""
    for i in range(0, min(len(clauses), _SECTIONS_CAP), _SECTIONS_CHUNK):
        ev: dict = {"kind": "read_sections", "sections": clauses[i:i + _SECTIONS_CHUNK]}
        if i == 0 and headings:
            ev["headings"] = headings
        await publish_event(getattr(ctx, "redis", None), getattr(ctx, "run_id", None), ev)


async def _publish_part(ctx, part: ReadResult) -> None:
    """把刚跑完那一轮的结果推给前端，让用户在整轮读标结束前就看到已解读的部分——
    大标书要十几分钟，干等到最后才出内容是最难熬的。best-effort：推送失败绝不影响读标本身。"""
    payload = _slim_part(part)
    if not payload:
        return
    await publish_event(getattr(ctx, "redis", None), getattr(ctx, "run_id", None),
                        {"kind": "read_part", "part": payload})


async def _segmented_read(ctx, user: str, clauses: list[dict]) -> ReadResult:
    """大标书分段读标:基础轮 + 格式构成轮 + 评分轮 + 技术需求按条款分块,节点内合并成一份 ReadResult。
    每轮字段范围受限、技术按条款分块——单轮输出与标书/包件规模解耦,恒不撞 8k 输出上限。
    所有轮**并发**执行(SEG_CONCURRENCY 信号量限流):总 token 不变,墙钟大幅缩短;
    每轮完成即推一条进度事件(已完成 X/N)。任一轮失败整个读标失败(与串行语义一致,run 可重试)。"""
    chunks = [clauses[i:i + TECH_CHUNK_CLAUSES] for i in range(0, len(clauses), TECH_CHUNK_CLAUSES)] or [[]]
    total = 3 + len(chunks)
    done = 0
    sem = asyncio.Semaphore(SEG_CONCURRENCY)
    await publish_phase(ctx, f"读标·并行提取中(共 {total} 轮:基础/格式/评分 + 技术 {len(chunks)} 块)")

    cached_hits = 0

    async def _run(round_id: str, user_msg: str, hint: str, label: str) -> ReadResult:
        nonlocal done, cached_hits
        key = _seg_cache_key(ctx, round_id, user_msg + hint)
        part = await _seg_cache_get(ctx, key)   # 断点续跑:上次已完成的轮直接复用,不重烧 token
        if part is None:
            async with sem:
                part = await _seg_submit(ctx, user_msg, hint, label)
            await _seg_cache_set(ctx, key, part)
        else:
            cached_hits += 1
        done += 1   # asyncio 单线程,计数无竞态
        suffix = f"(续跑复用 {cached_hits})" if cached_hits else ""
        await publish_phase(ctx, f"读标·并行提取中 已完成 {done}/{total} 轮{suffix}")
        await _publish_part(ctx, part)   # 该轮已解读的内容立刻上屏（展示态，权威结果仍以 step.done 为准）
        return part

    # 骨架三轮喂全文(user);技术块轮喂独立瘦身消息(只含本块条款,见 _tech_chunk_user)。
    # return_exceptions:单轮失败不取消其他在途轮——让能成功的轮都跑完并存档,重试时只补失败的
    # (默认 gather 会立刻取消同批任务,在途轮的 token 就白花了)。全部落定后再抛第一个错。
    results = await asyncio.gather(
        _run("base", user, _SEG_BASE, "读标·基础轮(meta+概况/资格/商务)"),
        _run("fmt", user, _SEG_FMT, "读标·格式构成轮(format+构成+包件+红线)"),
        _run("score", user, _SEG_SCORE, "读标·评分轮"),
        *[_run(f"tech{idx}", _tech_chunk_user(chunk, idx, len(chunks)), "",
               f"读标·技术第{idx}/{len(chunks)}块")
          for idx, chunk in enumerate(chunks, start=1)],
        return_exceptions=True,
    )
    errs = [r for r in results if isinstance(r, BaseException)]
    if errs:
        logger.error("分段读标 %d/%d 轮失败(成功轮已存档,重试续跑)", len(errs), total)
        raise errs[0]
    base, fmt, score, *tech_parts = results
    # gather 保序:tech_parts 与 chunks 顺序一致,技术项合并后条款顺序不变。
    tech_items = [it for part in tech_parts
                  for c in part.categories if c.key == "technical" for it in c.items]
    # 代码级兜底(与块轮提示词双保险):块轮看不到全局包件表,模型若无视指令猜了包件 id,
    # 错标会让选包过滤静默丢 ★ 需求——强制清空,空=全包通用,下游只会多保留不会丢。
    for it in tech_items:
        it.packages = []
    # 合并:各轮只产自己负责的字段,取并集;基础轮做底座(project_meta 在其上)。
    keep = {"overview", "qualification", "commercial"}
    cats = [c for c in base.categories if c.key in keep]
    cats += [c for c in fmt.categories if c.key == "format"]
    cats.append(ReadCategory(key="technical", title="技术需求", items=tech_items))
    return base.model_copy(update={
        "categories": cats,
        "scoring": score.scoring,
        "risk_summary": fmt.risk_summary or base.risk_summary,
        "required_structure": fmt.required_structure,
        "packages": fmt.packages,
    })


async def _index_tender(ctx, run_input: dict, clauses: list[dict]) -> None:
    """best-effort 索引招标条款分句供 RAG 检索（spec316 A2）：条款已是天然分块，不再过 chunker。
    整段 try/except（含 gate 判定），任何异常仅 warning，绝不影响 read 交付。"""
    if not clauses:
        return
    try:
        if not await rag_retrieve.rag_enabled(ctx.user_id, run_input):
            return
        texts = [c.get("text", "") for c in clauses]
        vectors = await rag_retrieve.embedder.embed(texts)
        metas = [{"clause_id": c.get("id")} for c in clauses]
        await asyncio.to_thread(rag_store.upsert, get_pool(), ctx.user_id, "tender",
                                 ctx.thread_id, texts, vectors, metas)
    except Exception:  # noqa: BLE001 索引失败（含 gate 抛错）绝不影响 read 节点交付
        logger.warning("rag index tender failed thread_id=%s", ctx.thread_id, exc_info=True)


def _parse_fail_reason(e: Exception) -> str:
    """解析失败 → 面向用户的可读原因（bug YFZQ-4：失败文件必须显式告知,不能静默丢）。
    沿 __cause__/__context__ 链下钻——解析库常把真因包一层,str(顶层) 未必含关键字（本仓韧性铁律）。"""
    parts: list[str] = []
    seen: set[int] = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        parts.append(str(cur).lower())
        cur = cur.__cause__ or cur.__context__
    msg = " ".join(parts)
    # 解析层已给出面向用户的具体说明（加密封装/内容与扩展名不符）时原样透出——它比下面的
    # 通用分类更准，也带了「该怎么办」。只认第一层，避免把底层库的英文报文当成给用户的话。
    if isinstance(e, UnsupportedDocument) and ("封装" in str(e) or "扩展名" in str(e)):
        return str(e)
    if any(k in msg for k in ("encrypt", "decrypt", "password", "加密", "已被口令")):
        return "文件已加密/设了打开密码，请去除密码保护后重新上传"
    if any(k in msg for k in ("unsupported", "不支持")):
        return "文件格式不支持（仅支持 doc/docx/pdf/xls/xlsx）"
    return "文件无法解析（可能已损坏、为扫描件或空文件）"


def _is_transient(e: BaseException) -> bool:
    """是否值得二次机会。存储侧取不到字节（DocumentUnavailable）是瞬时的，让模型调
    parse_document 再试一次有意义；文件本身的问题（加密封装/损坏/格式不支持）再试一百次也一样。
    沿 __cause__/__context__ 链下钻——真因常被包一层（本仓韧性铁律）。"""
    seen: set[int] = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, DocumentUnavailable):
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def _fail_if_all_permanent(failed: list[dict]) -> None:
    """一份都没解析出来、且全都是文件本身的问题 ⇒ 当场失败并说清是哪份文件、什么原因。

    此前这里会静默走「让模型自己调 parse_document」的兜底路径：模型连调工具全失败，最后抛
    「模型未通过 submit_read_result 提交结构化结果」——四轮 token 白烧，报错还把排查方向指向模型
    （2026-08-05 生产事故）。兜底只对瞬时错误有意义，故仅在全部为永久错误时提前失败。"""
    if not failed or any(f.get("transient") for f in failed):
        return
    detail = "；".join(f"《{f['name']}》{f['reason']}" for f in failed)
    raise RuntimeError(f"招标文件无法解析，读标终止：{detail}")


def _fail_if_all_scanned(docs: list[tuple[str, object]]) -> None:
    """每一份招标文件都是扫描件（每页都提不出文字）⇒ 当场诚实拒绝。

    这类文件「解析成功」却零有效条款：页码/页眉还能刮出几条残渣，够让节点一路放行到烧模型那一步，
    最后以「模型未提交结构化结果」收场——钱烧了，报错还把排查方向指向模型（同 _fail_if_all_permanent
    要治的那种事故，只是入口不同：那边是解析抛错，这边是解析「成功」）。

    **读标故意不复用审查那套 OCR**：读标产出的 clause_id 是全链路（提纲/正文/审查/前端左栏定位）
    的锚点，必须逐字对得上招标原文；OCR 是逐页近似识别，切出来的条款既不稳定也回指不到原文位置，
    拿它当锚点等于让下游全部引用悬空。看不见就说看不见，让用户换一份可复制文字的版本。"""
    if not docs or not all(getattr(d, "pages", None) and d.image_pages >= d.pages
                           for _, d in docs):
        return
    names = "、".join(f"《{n}》" for n, _ in docs)
    raise RuntimeError(f"招标文件为扫描件，无法提取文字，请上传可复制文字的版本：{names}")


def _public_failed(failed: list[dict]) -> list[dict]:
    """回传前端的失败清单：只留 name/reason，不外泄内部的瞬时/永久分类字段。"""
    return [{"name": f["name"], "reason": f["reason"]} for f in failed]


async def _parse_multi_files(files: list[dict]) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """spec320：并发解析多份招标文件；单份失败不阻塞其余文件——成功的按 merge_parsed 合并
    （章节号整体偏移，sec-N-cM 锚点体系不变）。失败文件收集为 [{name, reason}] 显式返回
    （bug YFZQ-4：加密/损坏文件此前静默跳过、读标只显示成功的,用户无从知晓——现必须回传告知）。"""
    async def _one(f):
        try:
            parsed = await asyncio.to_thread(read_and_parse, f["key"])
            return (f.get("name", f["key"]), parsed), None
        except Exception as e:  # noqa: BLE001 单文件解析失败降级跳过，不崩整个读标,但要记原因
            logger.warning("read_and_parse 失败 key=%s", f.get("key"), exc_info=True)
            return None, {"name": f.get("name", f.get("key", "")), "reason": _parse_fail_reason(e),
                          "transient": _is_transient(e)}
    results = await asyncio.gather(*[_one(f) for f in files])
    docs = [ok for ok, _ in results if ok is not None]
    failed = [bad for _, bad in results if bad is not None]
    _fail_if_all_scanned(docs)      # 全是扫描件 ⇒ 当场失败，别让模型去读一堆页码
    clauses, file_ranges, headings = merge_parsed(docs)
    return clauses, file_ranges, failed, headings


def _multi_file_prompt(clauses: list[dict], file_ranges: list[dict]) -> str:
    """多文件 prompt：条款 JSON 前加一段文件清单，标出每个文件占用的章节区间。"""
    file_list = "\n".join(
        (f"文件{i}《{fr['name']}》＝章节 {fr['sec_from']}..{fr['sec_to']}"
         if fr["sec_to"] >= fr["sec_from"] else f"文件{i}《{fr['name']}》＝无可解析条款")
        for i, fr in enumerate(file_ranges, start=1))
    return (f"{file_list}\n\n招标文件已解析为条款分句（id 为稳定锚点，clause_ids 直接引用，"
            f"无需再调 parse_document）：\n{json.dumps(clauses, ensure_ascii=False)}\n\n请读标。")


def make_read_node(ctx):
    """graph 节点：读招标文件 → 产 ReadResult → 写入 state['read']；模型未提交即失败（可重试）。
    spec315a：节点先确定性解析一次拿条款分句（锚点 sec-N-cM），直接注入 prompt 省掉工具二次解析；
    分句并入 read result 交付前端左栏原文（不另设 state 通道，无第二个读取方）。
    spec316 A2：分句到手后 best-effort 索引进资料库 RAG（source_type=tender），供后续内容生成检索引用。
    spec320：state["files"] 非空 ⇒ 多文件解析+合并（章节号偏移），read 结果加 doc_files；
    files 缺省时走原 file_key 单文件路径，逐字节不变（Global Constraint）。"""
    async def read_node(state):
        files = state.get("files") or []
        extra: dict = {}
        headings: list[dict] = []   # 章节标题（左栏按层级渲染用；解析失败降级为空，页面回落旧的「第N部分」）
        if files:
            clauses, file_ranges, failed_files, headings = await _parse_multi_files(files)
            if not clauses:      # 全是文件本身的问题就当场失败，别让模型去兜一个兜不住的底
                _fail_if_all_permanent(failed_files)
            # 全部预解析失败的兜底：列出各文件 key，模型才有 key 可调 parse_document 重试
            keys = "、".join(f"{f.get('name', '')}(key={f.get('key', '')})" for f in files)
            user = (_multi_file_prompt(clauses, file_ranges) if clauses
                    else f"多文件招标预解析失败，请逐个调用 parse_document 读标，文件：{keys}")
            extra["doc_files"] = file_ranges
            if failed_files:  # bug YFZQ-4：读取失败的文件显式回传前端告知,不静默丢
                extra["failed_files"] = _public_failed(failed_files)
        else:
            # boto3/解析皆同步 → 丢线程池。注意：工具兜底走的是同一个 read_and_parse——
            # 只对瞬时错误（存储/网络抖动）算二次机会；文件本身损坏则两路都失败，读标退化为无原文可引。
            name = state["file_key"].rsplit("/", 1)[-1]
            try:
                parsed = await asyncio.to_thread(read_and_parse, state["file_key"])
            except Exception as e:  # noqa: BLE001 瞬时错误降级让模型调 parse_document 重试
                parsed = None
                # 文件本身的问题（加密封装/损坏/格式不支持）当场失败——此前这里把异常整个吞掉，
                # 连原因都不留，最后以「模型未提交结构化结果」收场。
                _fail_if_all_permanent([{"name": name, "reason": _parse_fail_reason(e),
                                         "transient": _is_transient(e)}])
            # 全扫描件的判定放在 try **之外**：放里面的话它抛的错会被上面那个 except 接住，
            # 当成一次解析失败重新分类，具体原因（扫描件）就被通用文案吃掉了。
            clauses = []
            if parsed is not None:
                _fail_if_all_scanned([(name, parsed)])
                clauses = parsed.clauses
                headings = parsed.headings
            if clauses:
                user = ("招标文件已解析为条款分句（id 为稳定锚点，clause_ids 直接引用，无需再调 parse_document）：\n"
                        f"{json.dumps(clauses, ensure_ascii=False)}\n\n请读标。")
            else:
                user = f"请对招标文件读标，key={state['file_key']}"
        # 原文先行：条款此刻已解析完，立刻推给前端——左栏不再空等，右栏流式条目也能点击定位。
        await _publish_sections(ctx, clauses, headings)
        # 条款已预解析注入 ⇒ 无需 parse_document 工具，走 _forced_submit 强制提交路径——
        # 它带截断重试（大标书读标输出撞 max_tokens 实测：图路径截断=单轮即失败，无法恢复）。
        # 仅预解析失败（clauses 空）才带工具走图路径，让模型自己调 parse_document 兜底。
        if len(clauses) > SEGMENT_CLAUSE_THRESHOLD:
            result = await _segmented_read(ctx, user, clauses)   # 大标书:骨架轮+技术分块(输出上限硬约束)
        else:
            result = await run_submit_agent(
                ctx, READ_SYSTEM_PROMPT, user,
                "submit_read_result", ReadResult, "提交读标结构化结果",
                extra_tools=None if clauses else [parse_document_tool])
        # RAG 索引后台执行,不挡结果交付:9273 条款标书实测索引要几十分钟(CPU 嵌入 ~11s/16条),
        # 用户花钱买的读标结论 20 分钟前就好了却在等一个 best-effort 的辅助索引。_index_tender 全程
        # try/except,后台失败只记警告;下游检索本就按"建好多少用多少"降级,索引未完不阻塞任何步骤。
        # TODO(可观测性): 后台索引失败/中断(如部署重启)目前只有 worker 日志,索引残缺时下游检索
        # 静默降级且无重触发入口——后续应把索引状态落到 read result 或提供手动重建索引的运维入口。
        task = asyncio.create_task(_index_tender(ctx, state.get("run_input") or {}, clauses))
        _BG_INDEX_TASKS.add(task)                       # 持引用防 GC 提前取消
        task.add_done_callback(_BG_INDEX_TASKS.discard)
        # 分类判定（spec334）：读标收尾的一次轻量调用，与 doc_sections 一样并进结果 dict 而**不进
        # ReadResult 的工具 schema**。这里**每次重跑都重新判**——read 步正是判定值的产地，
        # 跳过它就意味着重跑读标再也刷不出新判定；用户的确认值另存在项目行，不受影响。
        read_result = result.model_dump()
        read_result["bid_category"] = await classify_from_read(ctx, read_result)
        return {"read": {**read_result, "doc_sections": clauses, "doc_headings": headings, **extra}}
    return read_node
