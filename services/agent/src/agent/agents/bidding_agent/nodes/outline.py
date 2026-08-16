from __future__ import annotations
import asyncio
import hashlib
import json
import logging
import re

from agent.config import settings
from agent.framework.create_agent import run_submit_agent
from agent.parsing import storage_read
from agent.agents.bidding_agent.nodes.common import slim_read, package_scope, filter_read_by_package, publish_phase
from agent.agents.bidding_agent.schemas import Outline
from agent.agents.bidding_agent.prompts.outline import OUTLINE_SYSTEM_PROMPT
from agent.agents.bidding_agent.prompts.categories import category_scope


def _structure_skeleton(items: list[dict]) -> str:
    """把 required_structure 渲染成骨架约束文本（spec321）：附加在用户消息末尾，
    要求每个 required=true 且 kind≠rule 的构成项都有对应章节并置 structure_ref。"""
    rows = [{"id": s.get("id"), "title": s.get("title"), "kind": s.get("kind"),
             "required": s.get("required", True), "notes": s.get("notes", "")} for s in items]
    return ("\n投标文件构成清单（骨架，required=true 且 kind≠rule 的项必须有对应章节并置 structure_ref；"
            f"价格/资格类表单章节正文占位即可）：\n{json.dumps(rows, ensure_ascii=False)}")


logger = logging.getLogger(__name__)

# 同一份招标文件 → 同一份提纲（2026-08-14 用户实测：同文件多跑几次,提纲 12↔15 章漂移,
# 相差很大）。键=文件字节哈希+系统提示词哈希(改提示词自动失效,不再靠手动升版)
# +范围域(选包/类别——不同包件的提纲本就该不同)。TTL 30 天。
_OUTLINE_TTL_S = 30 * 24 * 3600


def _read_file_bytes(key: str) -> bytes:
    """独立小函数：测试可替换、失败面单一。"""
    return storage_read.read_bytes(key)


async def _tender_digest(state: dict) -> str | None:
    """主招标文件字节哈希；取不到（无文件/存储抖动）返回 None＝本轮不缓存，绝不挡生成。"""
    files = state.get("files") or []
    key = str((files[0] or {}).get("key") or "") if files else ""
    if not key:
        return None
    try:
        data = await asyncio.to_thread(_read_file_bytes, key)
        return hashlib.sha256(data).hexdigest()[:24]
    except Exception:  # noqa: BLE001
        logger.warning("提纲缓存：读取招标文件字节失败，本轮不缓存", exc_info=True)
        return None


# 提纲矫正逻辑版本（评审 2026-08-15 F1）：矫正在缓存命中后跑，通常升级**无需**动它；
# 但某个历史版本写入过「矫正无法逆推」的形状时必须升版换键——r2：8d28e64 曾把
# 「已拆但无 after_id 锚」的提纲入缓存，拆章对它无从下手（父子关系信息已丢），
# 错序会钉满 30 天 TTL。升版让旧条目自然失效重生成。
_OUTLINE_REV = "r2"


def _cache_key(digest: str, state: dict) -> str:
    scope = json.dumps({"package": (state.get("run_input") or {}).get("package"),
                        "category": (state.get("run_input") or {}).get("bid_category")},
                       ensure_ascii=False, sort_keys=True)
    pv = hashlib.sha256(OUTLINE_SYSTEM_PROMPT.encode("utf-8")).hexdigest()[:8]
    sc = hashlib.sha256(scope.encode("utf-8")).hexdigest()[:8]
    return f"{settings.redis_prefix}outline:{digest}:{pv}:{sc}:{_OUTLINE_REV}"


_CN_DIG = "零一二三四五六七八九"


def _cn_num(n: int) -> str:
    """1..99 → 中文序数（一/十/十一/二十…），章号重编用。"""
    if n < 10:
        return _CN_DIG[n]
    tens, ones = divmod(n, 10)
    head = "十" if tens == 1 else _CN_DIG[tens] + "十"
    return head + (_CN_DIG[ones] if ones else "")


def _reorder_chapters(outline: dict, structure: list[dict]) -> dict:
    """提纲章序**代码定序**（2026-08-15 用户实测 849b02b1 轮：模型把技术偏离表夹进商务
    表单中间、商务条款章掉到全书末尾——提示词写着「章序照抄构成顺序」，提示词只能请求，
    代码才能保证）。规则：商务组连续在前、技术组在后（与分册导出/预算的分组口径一致）；
    组内有构成项引用的按招标构成清单**文档序**，无引用的保持模型相对序缀在本组末；
    重排后重编「第N章」。缓存命中的提纲同样过这里——旧缓存的乱序当场矫正。"""
    chapters = outline.get("chapters") or []
    if not chapters:
        return outline
    # after_id 锚（拆章产物）根本不进排序——引用不参与、也不能参与拆出章的座次
    # （2026-08-15 生产实测 9016677d：缓存旧提纲的章全无引用，拆出章带引用被
    # 「有引用排前面」抬到组首，授权书成了第一章）。先摘后排，排完插回父章之后。
    anchored = [ch for ch in chapters
                if ch.get("after_id") and ch.get("form_order") is None]  # 有槽位序的听槽位的
    rest = [ch for ch in chapters
            if not (ch.get("after_id") and ch.get("form_order") is None)]  # 同一条件直陈（评审 F）
    ref_order = {str(s.get("id")): i for i, s in enumerate(structure)}

    def key(pair):
        idx, ch = pair
        grp = 1 if ch.get("group") == "tech" else 0
        # 商务表单章按招标**表单文档序**最优先（form_order，_canonical_form_chapters 挂的）
        # ——章序从此不看模型给的顺序；其后才轮到构成引用序/模型相对序。
        fo = ch.get("form_order")
        ref = ref_order.get(str(ch.get("structure_ref") or ""))
        return (grp,
                0 if fo is not None else 1, fo if fo is not None else 0,
                0 if ref is not None else 1, ref if ref is not None else idx, idx)

    ordered = [ch for _, ch in sorted(enumerate(rest), key=key)]
    for ch in anchored:
        pos = next((i for i, c in enumerate(ordered) if str(c.get("id")) == ch["after_id"]), None)
        if pos is None:
            # 锚章不在（提纲被编辑删了）：落**本组**末尾——落全书末尾等于商务拆出章
            # 跟在技术方案后面，文件顺序错乱（评审 F2）。
            grp = ch.get("group")
            pos = max((i for i, c in enumerate(ordered) if c.get("group") == grp),
                      default=len(ordered) - 1)
        j = pos + 1                       # 同父多子保持拆出相对序：跳过已插的兄弟
        while j < len(ordered) and ordered[j].get("after_id") == ch["after_id"]:
            j += 1
        ordered.insert(j, ch)
    for i, ch in enumerate(ordered):
        ch["no"] = f"第{_cn_num(i + 1)}章"
    outline["chapters"] = ordered
    return outline


def _split_form_chapters(outline: dict, read_state: dict, index: list[dict]) -> dict:
    """被折进别章的独立表单模板，代码硬拆成独立章（2026-08-15 fd5a6ced 实测：模型把
    「法定代表人授权书」折进响应函章当小节——表单章零模型路径按章名只取一份模板，
    折叠小节整体蒸发，菜单有、正文无。「一表一章」提示词只能请求，代码才能保证）。
    判定由 form_locate.folded_form_items 给出（强匹配全文表单索引、非本章自己那份、
    无独立章认领）；拆出的新章插在原章之后（无构成引用时 _reorder_chapters 按相对序
    保持相邻），构成引用按标题精确对回清单，重排重编号交给 _reorder_chapters。
    生成后+缓存命中后都过：旧缓存里的折叠提纲命中即矫正，不用清缓存。幂等。"""
    from agent.agents.bidding_agent.nodes.form_locate import _match_tier, folded_form_items
    chapters = outline.get("chapters") or []
    if not chapters:
        return outline
    folded = folded_form_items(chapters, index)
    if not any(folded.values()):
        return outline
    structure = read_state.get("required_structure") or []
    seen = {str(c.get("id") or "") for c in chapters}
    out: list[dict] = []
    for ch in chapters:
        out.append(ch)
        hoisted = folded.get(str(ch.get("id") or ""), [])
        for item, core in hoisted:
            ch["items"] = [it for it in ch.get("items") or [] if it is not item]
            nid = f"{ch.get('id')}f"
            while nid in seen:
                nid += "x"
            seen.add(nid)
            # after_id 锚无条件带上——座次只由锚定（紧跟父章，见 _reorder_chapters）。
            # 构成引用另按标题强匹配（全同/互含，「附件：法定代表人授权书」也对得上）
            # 留给模板投递的 struct 路；绝不借父章的 structure_ref——会错发父章模板。
            new_ch = {"id": nid, "no": "", "desc": "", "title": core,
                      "group": ch.get("group") or "business", "sourced": True,
                      "after_id": str(ch.get("id") or ""),
                      "items": item.get("children") or [dict(item, label=core, children=[])]}
            ref = next((str(s.get("id")) for s in structure
                        if (t := _match_tier(core, str(s.get("title") or ""))) is not None
                        and t <= 1), None)
            if ref:
                new_ch["structure_ref"] = ref
            logger.info("提纲拆章：「%s」自「%s」拆出为独立表单章", core, ch.get("title"))
            out.append(new_ch)
        if hoisted:
            _renumber_cn_items(ch.get("items") or [])
    outline["chapters"] = out
    return outline


# 容忍与折叠判定同幅度的形态（评审 F4：数字序/前导空格）——只认裸中文序会留断号/重号
_ORD_LABEL = re.compile(r"^\s*([0-9]{1,3}|[一二三四五六七八九十]{1,3})、")


def _renumber_cn_items(items: list) -> None:
    """拆章摘走小节后，父章剩余顶级小节的「N、」序号重编（2026-08-15 用户实测
    「中间的第二节呢」：授权书（二）拆走后剩「一、」「三、」）。各标签保持自己的
    数字/中文风格；其他编号风格（「（一）」等）不碰。"""
    n = 0
    for it in items:
        label = str(it.get("label") or "") if isinstance(it, dict) else ""
        m = _ORD_LABEL.match(label)
        if not m:
            continue
        n += 1
        num = str(n) if m.group(1).isdigit() else _cn_num(n)
        it["label"] = _ORD_LABEL.sub(f"{num}、", label, count=1)


# 商务/技术边界（2026-08-15 用户拍板：商务标模板章是复刻招标书的，不需要模型发挥；
# 边界必须定义清楚）——版式类不成章；技术侧(偏离/方案类)不补章不改组，那是模型的地盘。
_FORM_SKIP_WORDS = ("封面", "封套", "目录", "装订", "密封", "文件格式")
_FORM_TECH_WORDS = ("偏离", "技术", "方案", "实施")


# 槽位名清洗：剥编号/附件前缀/★弹头/内部空白。「1★保密承诺书」「保 密承诺书」是同一份，
# 不清洗既会拿脏名去建章，也会把同一份表单当成两个槽位补两次章（2026-08-16 41 份回放）。
_SLOT_PREFIX = re.compile(
    r"^(?:附件|附表|附录|表)?\s*[0-9０-９]+(?:[-－.．][0-9０-９]+)*\s*[.、．)）]?\s*"
    r"|^[一二三四五六七八九十]{1,3}[、.．]\s*"
    r"|^[★▲◆■□●○•·※]+\s*"
    r"|^附件[一二三四五六七八九十]+\s*"
    r"|^附[:：]?\s*")
# 章/部分/节级标题不是**一份表单**：「第三章 报价文件内容及格式」「第六部分 格式附件」
# 补成章 = 提纲里凭空多出一个装不下东西的壳（41 份回放实证）。
_SLOT_CHAPTER = re.compile(r"第[一二三四五六七八九十百千\d]+[章节部篇]")
# 以这些收尾的是**要求/说明条款**，不是要填的表单
_SLOT_BAD_TAIL = ("要求", "说明", "规定", "摘录", "目录", "格式")
_SLOT_MIN_BODY = 30      # 段内可见字下限：解析碎片切出来的段几乎没内容
# 正文起手词开头的不是表单名：「特此证明」是落款行，不是一份要填的证明（41 份回放）
_SLOT_BAD_HEAD = ("特此", "兹", "现将", "备注", "以上")


def _slot_name(raw: str) -> str:
    """段名 → 干净的表单名（剥前缀噪音+内部空白）。"""
    name = str(raw or "").strip()
    while True:                       # 反复剥：「1★保密承诺书」要连剥编号与弹头两层
        stripped = _SLOT_PREFIX.sub("", name, count=1).strip()
        if stripped == name:
            break
        name = stripped
    return re.sub(r"[\s　]+", "", name)


def _is_form_slot(raw_name: str, body: str) -> bool:
    """这一段够不够格当**商务表单槽位**（代码要据它建章，宁缺毋滥——补错一个章
    比漏补一个章糟得多：漏补时模型产出的章还在，补错是凭空多一个空壳）。"""
    from agent.agents.bidding_agent.nodes.form_locate import _PROSE_PUNCT, _looks_like_form_title
    name = _slot_name(raw_name)
    if not (3 <= len(name) <= 12) or _PROSE_PUNCT.search(name):
        return False
    if len(name) == 3 and not name.endswith("函"):
        return False              # 三字表单名只有「响应函/报价函/投标函」这一族；
                                  # 「证证明」这类解析碎片同样三字、同样以证明收尾（41 份回放）
    if _SLOT_CHAPTER.search(str(raw_name)) or name.endswith(_SLOT_BAD_TAIL):
        return False
    if name.startswith(_SLOT_BAD_HEAD):
        return False
    if any(w in name for w in _FORM_SKIP_WORDS + _FORM_TECH_WORDS):
        return False
    if not _looks_like_form_title(name):
        return False
    return len(re.sub(r"[\s　]+", "", body)) >= _SLOT_MIN_BODY


def _form_slots(index: list[dict]) -> list[dict]:
    """招标全文的**商务表单槽位**（文档序）。权威=全文表单索引——它来自解析器切分的
    doc_sections，不经模型，同一份文件必得同一份槽位表。这是「商务标章清单代码直出」
    的确定性根基。同名段按归一名去重取首现（评审 B：须知构成清单与格式章真表单同名，
    不去重则第二个槽位没人认领、补章造出重复章并随缓存钉死）。"""
    from agent.agents.bidding_agent.nodes.form_locate import segment_text
    slots, seen = [], set()
    for seg in index:
        raw = str(seg.get("name") or "")
        body = segment_text(seg)
        if not body or not _is_form_slot(raw, body):
            continue
        name = _slot_name(raw)
        if name in seen:
            continue
        seen.add(name)
        # 复合名（「资格文件及资格信用承诺函」）是**分组标题**不是一份表单：可以被章
        # 认领来定序，但绝不据它补章——补出来是个装不下东西的壳（41 份回放）。
        slots.append({"name": name, "composite": bool(_COMPOSITE_RE.search(name))})
    return slots


# 材料清单类表单（资格文件/证明材料/材料清单）：小节是证照就位与正文写作的骨架，
# 规范占位不作用于它们——抹掉等于让模型/证照就位失去落点。
_KEEP_ITEMS_WORDS = ("资格文件", "证明材料", "材料清单")

# 复合名连接词：**必须与 form_locate._match_tier 的拆件集合同一份**（评审 D：只认[及和]时
# 「资格声明与承诺函」这类与-连接的复合槽位照样把承诺函章改名抹节）。
_COMPOSITE_RE = re.compile(r"[与及和、/]")


def _canonical_items(ch: dict, label_name: str) -> list[dict]:
    """表单章小节 → 规范占位一条（2026-08-15 用户拍板续：模型这次写「身份证明」下次写
    「授权书正文」，菜单每轮一副面孔）。原小节树上的 clause_ids **全深度汇总保留**——
    定位原文跳转与模板定位的 clause 捷径都靠它。"""
    cids: list[str] = []

    def collect(items, depth=0):
        if depth > 8 or not isinstance(items, list):
            return
        for it in items:
            if not isinstance(it, dict):
                continue
            for c in it.get("clause_ids") or []:
                if c not in cids:
                    cids.append(c)
            collect(it.get("children"), depth + 1)

    collect(ch.get("items") or [])
    nid = str(ch.get("id") or "")
    return [{"id": f"{nid}-1", "desc": "", "is_new": False, "children": [],
             "label": f"一、{label_name}（按招标格式填写）", "clause_ids": cids}]


def _canonical_form_chapters(outline: dict, index: list[dict]) -> dict:
    """商务表单章代码定版（2026-08-15 用户拍板：招标书里写死的表单，一个字不让模型碰。
    此前拆章/锚定只是纠正模型，模型每次重新生成仍是一副新面孔——章有章无、简称全称、
    顺序都在漂）。三刀：
    ①认领：章名与槽位强匹配（全同/互含）→ 挂上槽位文档序 form_order；简称归一为
      招标原文名（复合名「资格文件及…」不动——把资格文件章改成复合名比不改更乱）；
      认领商务表单段的章一律归商务组（模型偶尔把响应函标成技术标）。
    ②补章：没人认领的槽位 → 代码补章（招标原文名+占位小节），绝不让招标要求的表单
      在提纲里消失。
    ③定序交给 _reorder_chapters：form_order 在商务组内最优先。
    生成后+缓存命中后都过，幂等（补出的章下轮按名认领回自己的槽位）。"""
    from agent.agents.bidding_agent.nodes.form_locate import _core_form_name, _match_tier
    chapters = outline.get("chapters") or []
    slots = _form_slots(index) if chapters else []
    if not slots:
        return outline
    claimed: dict[int, dict] = {}
    taken: set[int] = set()
    # 两遍认领（评审 C）：先全同、后互含——贪心首中会让「响应函格式符合性说明」章
    # 抢走「响应函」槽位并被改名，真响应函章反而没了着落。
    for tier_limit in (0, 1):
        for ch in chapters:
            if ch.get("system") or str(ch.get("id") or "") == "sys-creds" or id(ch) in taken:
                continue
            core = _core_form_name(str(ch.get("title") or ""))
            for si, slot in enumerate(slots):
                if si in claimed:
                    continue
                t = _match_tier(core, slot["name"])
                if t is not None and t <= tier_limit:
                    claimed[si] = ch
                    taken.add(id(ch))
                    break
    seen = {str(c.get("id") or "") for c in chapters}
    created: list[dict] = []
    for si, slot in enumerate(slots):
        if si in claimed or slot.get("composite"):
            continue
        nid = f"bf{si + 1}"
        while nid in seen:
            nid += "x"
        seen.add(nid)
        ch = {"id": nid, "no": "", "desc": "", "title": slot["name"], "group": "business",
              "sourced": True, "items": [{"id": f"{nid}-1", "is_new": False, "desc": "",
                                          "label": f"一、{slot['name']}（按招标格式填写）",
                                          "children": [], "clause_ids": []}]}
        claimed[si] = ch
        created.append(ch)
        logger.info("提纲表单补章：「%s」（招标要求的表单，模型漏排）", slot["name"])
    for si, ch in claimed.items():
        ch["form_order"] = si
        ch["group"] = "business"
        name = slots[si]["name"]
        if ch.get("title") != name and not _COMPOSITE_RE.search(name):
            ch["title"] = name
        # 小节统一规范占位（复合名槽位、材料清单类不动——见 _KEEP_ITEMS_WORDS）
        title = str(ch.get("title") or name)
        if (ch not in created and not _COMPOSITE_RE.search(name)
                and not any(w in title for w in _KEEP_ITEMS_WORDS)):
            ch["items"] = _canonical_items(ch, title)
    outline["chapters"] = chapters + created
    return outline


def _remap_structure_refs(outline: dict, ref_titles: dict, structure: list[dict]) -> dict:
    """跨项目复用提纲时，structure_ref 指向**旧一轮读标**的构成项 id——id 由读标模型自拟，
    跨轮不稳。按标题精确重映射到本轮构成项；映射不上的删引用（模板定位/偏离投递都有
    标题兜底通路，缺引用只是少一条捷径，错引用才是事故）。"""
    by_title = {str(s.get("title") or ""): s.get("id") for s in structure}
    for ch in outline.get("chapters") or []:
        ref = ch.get("structure_ref")
        if not ref:
            continue
        new = by_title.get(str(ref_titles.get(str(ref)) or ""))
        if new:
            ch["structure_ref"] = new
        else:
            ch.pop("structure_ref", None)
    return outline


def _normalize_outline(outline: dict, read_state: dict, structure: list[dict]) -> dict:
    """生成后/缓存命中后共用的确定性矫正管线：拆章 → 商务表单章定版 → 定序重编号。
    全文表单索引只建一次（评审 E：1MB 级标书两条路径各重建一遍是纯浪费，且该扫描
    同步阻塞事件循环）。"""
    from agent.agents.bidding_agent.nodes.form_locate import build_form_index
    index = build_form_index(read_state)
    outline = _split_form_chapters(outline, read_state, index)
    outline = _canonical_form_chapters(outline, index)
    return _reorder_chapters(outline, structure)


def make_outline_node(ctx):
    """graph 节点：读 state['read']（读标结论）→ 产 Outline → 写 state['outline']；模型未提交即失败（可重试）。
    read.required_structure 非空时追加骨架约束（spec321）；run_input.package 存在时追加包件范围约束
    （spec324）；均缺省时用户消息与此前行为字节级一致。"""
    async def outline_node(state):
        await publish_phase(ctx, "依据读标结论编排投标文件提纲")
        # 选包时读标收窄到该包(spec324 优化):提纲只按该包的需求/评分/构成搭建,上下文大降。
        read_state = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
        structure_now = read_state.get("required_structure") or []
        digest = await _tender_digest(state)
        key = _cache_key(digest, state) if digest else None
        r = getattr(ctx, "redis", None)
        if key and r:
            try:
                raw = await asyncio.to_thread(r.get, key)
            except Exception:  # noqa: BLE001 缓存 best-effort
                raw = None
            if raw:
                data = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
                logger.info("提纲缓存命中（同文件同域），零模型复用")
                cached_outline = _remap_structure_refs(
                    data.get("outline") or {}, data.get("ref_titles") or {}, structure_now)
                return {"outline": _normalize_outline(cached_outline, read_state, structure_now)}
        read = json.dumps(slim_read(read_state), ensure_ascii=False)
        user = f"读标结论：\n{read}\n请据此产出提纲。"
        structure = read_state.get("required_structure") or []
        if structure:
            user += _structure_skeleton(structure)
        user += package_scope(state.get("run_input"))
        # 分类必备章节（spec334）：只取主类别——提纲结构只能有一套，两套会膨胀出重复骨架
        user += category_scope((state.get("run_input") or {}).get("bid_category"), "chapters")
        # attempts=5（评审 2026-08-14）：两组必非空的语义校验上线后，省力模型可能连吃几轮
        # 拒绝——3 轮耗尽=整步失败退款，比多跑两轮糟得多（present 骨架同因放宽的先例）。
        # temperature=0（2026-08-14）：缓存未命中的首跑也要稳——提纲是结构决策,不该靠采样发挥
        result = await run_submit_agent(
            ctx, OUTLINE_SYSTEM_PROMPT, user,
            "submit_outline", Outline, "提交提纲", attempts=5, temperature=0.0)
        outline = _normalize_outline(result.model_dump(), read_state, structure_now)
        if key and r:
            payload = json.dumps(
                {"outline": outline,
                 "ref_titles": {str(s.get("id")): str(s.get("title") or "") for s in structure_now}},
                ensure_ascii=False)
            try:
                await asyncio.to_thread(r.set, key, payload, ex=_OUTLINE_TTL_S)
            except Exception:  # noqa: BLE001
                logger.warning("提纲缓存写入失败（不影响交付）", exc_info=True)
        return {"outline": outline}
    return outline_node
