from __future__ import annotations
import json
import logging
import re

from agent.framework.create_agent import run_submit_agent
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
    重排后重编「第N章」。"""
    chapters = outline.get("chapters") or []
    if not chapters:
        return outline
    # after_id 锚（拆章产物）根本不进排序——引用不参与、也不能参与拆出章的座次
    # （2026-08-15 生产实测 9016677d：旧提纲的章全无引用，拆出章带引用被
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
    生成后即过一遍，幂等。"""
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
    r"|^附(?![加带属])[:：]?\s*")   # 附资信证明→资信证明；附加服务承诺书 一个字都不动
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
    from agent.agents.bidding_agent.nodes.form_locate import (
        _FORM_WORDS, _PROSE_PUNCT, _looks_like_form_title)
    name = _slot_name(raw_name)
    if not (3 <= len(name) <= 12) or _PROSE_PUNCT.search(name):
        return False
    if (len(name) == 3 and not any(w in name for w in _FORM_WORDS)
            and not name.endswith("函")):
        return False              # 三字名必须靠**构词短语**命中（承诺书/授权书/声明书/一览表…）
                                  # 或是「XX函」；「证证明」只靠 _FORM_SUFFIXES 的证明后缀
                                  # 蒙混过关，三字里这种碎片占比最高（41 份回放）
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
    不去重则第二个槽位没人认领、补章造出重复章）。"""
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
    生成后即过一遍，幂等（补出的章下轮按名认领回自己的槽位）。"""
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
    """生成后的确定性矫正管线：拆章 → 商务表单章定版 → 定序重编号。
    全文表单索引只建一次（评审 E：1MB 级标书重复重建是纯浪费，且该扫描
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
        # 沿用既有提纲（2026-08-16 用户口径：提纲可编辑，改好的那版应能被同一份标书的下个
        # 项目沿用）。App 显式请求时把那一版随 state_overrides 灌进来：零模型原样返回，
        # **不过代码定版**——用户改过的提纲用户说了算，定版只作用于模型刚吐出的那一瞬；
        # 只认显式标志，不认「state 里碰巧有提纲」：同线程重试时状态里本来就有上一版。
        reused = state.get("outline") or {}
        if (state.get("run_input") or {}).get("reuse_outline") and reused.get("chapters"):
            await publish_phase(ctx, "沿用既有提纲", 1, 1, span=(0, 100))
            # 构成引用必须重映射到**本轮读标**（评审 2026-08-16 F2）：沿用的提纲来自另一次
            # 读标，structure_ref 是那一轮读标模型自拟的 id、跨轮不稳——不映射就会让模板
            # 投递按错 ref 把别的表单原文发给某章，再被复印机逐字钉死（2026-08-12 云上江西
            # 模板错位同一条路径）。这是**跨轮 id 对齐**，不是内容改写：章名/小节/章序
            # 一个字不动，用户的编辑仍然说了算。
            structure_now = filter_read_by_package(
                state.get("read") or {}, state.get("run_input")).get("required_structure") or []
            ref_titles = {str(c.get("structure_ref")): str(c.get("title") or "")
                          for c in reused["chapters"] if c.get("structure_ref")}
            reused = _remap_structure_refs(reused, ref_titles, structure_now)
            logger.info("提纲沿用：调用方下发既有提纲 %d 章，零模型",
                        len(reused["chapters"]))
            return {"outline": reused}
        # 提纲内部是**一次**模型调用，拆不出真实阶段——只声明整步区间，前端按预估时间
        # 在区间内插值（封顶 99，真正完成由 step.done 收口）。硬拆成假阶段只会给出假进度。
        await publish_phase(ctx, "依据读标结论编排投标文件提纲", span=(0, 100))
        # 选包时读标收窄到该包(spec324 优化):提纲只按该包的需求/评分/构成搭建,上下文大降。
        read_state = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
        structure_now = read_state.get("required_structure") or []
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
        # temperature=0（2026-08-14）：提纲是结构决策,不该靠采样发挥。
        # 提纲已不缓存,每次都重新生成（2026-08-25 用户口径）。**注意 temperature=0 只保证
        # 同一输入稳定,不保证跨项目稳定**：读标分段缓存按 thread_id 隔离（read.py:_seg_cache_key）,
        # 同一份标书在新项目里会重跑读标,required_structure 变了提纲就会变——2026-08-14
        # 实测的「同文件 12↔15 章漂移」正是这条路径,当时靠提纲缓存压住,现在不再有该保护。
        # 要跨项目一致,走用户显式的「沿用既有提纲」（run_input.reuse_outline）。
        result = await run_submit_agent(
            ctx, OUTLINE_SYSTEM_PROMPT, user,
            "submit_outline", Outline, "提交提纲", attempts=5, temperature=0.0)
        return {"outline": _normalize_outline(result.model_dump(), read_state, structure_now)}
    return outline_node
