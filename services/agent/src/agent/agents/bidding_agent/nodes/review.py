from __future__ import annotations
import json
from agent.framework.budget import run_with_shrink
from agent.framework.create_agent import run_submit_agent
from agent.agents.bidding_agent.nodes.common import (
    slim_read, filter_read_by_package, parse_bid_docs, publish_phase, html_to_review_text,
    allocate_chapter_budget, chapters_budget, chapters_in_outline, compress_read,
    MIN_CHAPTER_CHARS,
)
from agent.agents.bidding_agent.nodes.classify import classify_from_chapters, empty_category
from agent.agents.bidding_agent.schemas import RiskReport
from agent.agents.bidding_agent.prompts.review import (
    REVIEW_SYSTEM_PROMPT, SCAN_REVIEW_RULE, scan_pages_note,
)
from agent.agents.bidding_agent.prompts.categories import category_scope, industry_patches
from agent.parsing.ocr import ocr_configured




# 本步的阶段名（前端横幅）。取材/OCR 之后要再发一次把它换回来，故抽成常量。
_PHASE = "逐条比对招标要求与标书内容"

# 通用自查（未提供招标文件）的口径说明:必须明示局限,防用户把自查结果当成对照审查结论
_SELF_CHECK_NOTE = (
    "\n【通用自查模式】本次未提供招标文件:只做标书自身的完整性、格式规范、常见废标点、"
    "敏感与前后矛盾表述的自查,不做招标条款对照。risk_summary 第一条必须原样写:"
    "「未提供招标文件,未做招标条款对照审查,以下为通用自查结果」。"
)


async def _resolve_category(ctx, run_input: dict, read_state: dict, chapters: dict[str, str]) -> tuple[dict, bool]:
    """本次审查生效的分类，以及**它是不是本节点现判出来的**（第二个返回值）。三条路：
    ① run_input **带这个键**（含空数组）→ 用户已表态，直接用、不再判。
       **必须按「键在不在」判断而不是真值**：空数组是「用户明确不用分类」，
       当成缺失会让下面两条路把知识又注回去，用户根本关不掉。
    ② 有读标结论 → 读标步已判过，不重复烧钱，取那一份；
    ③ 自查模式（没有招标文件、也就没有读标结论）→ 拿上传标书正文现判。

    为什么要回报「是不是现判的」：只有 ③ 才是真正的**系统判定**，值得随结果落库当判定值。
    ①②回写的话，App 侧读「最近一条带分类的步结果」会读到用户自己的选择，把它当成系统判定——
    纠偏样本会记出「系统从没做过的判错」，清除确认值也会回落到用户自己的旧选择。"""
    if "bid_category" in run_input:
        return {**empty_category(), "value": list(run_input["bid_category"] or [])}, False
    if read_state:
        return (read_state.get("bid_category") or empty_category()), False
    return await classify_from_chapters(ctx, chapters), True


async def _resolve_chapters(ctx, state: dict, run_input: dict) -> tuple[dict[str, str], list[dict]]:
    """本次受审的正文 {章id: html}，以及受审文件里 OCR 之后**仍**看不见的页数统计
    （见 parse_bid_docs：扫描页先送 OCR，识别出来的字并进正文）。"""
    chapters_src = state.get("chapters") or {}
    scanned: list[dict] = []
    # spec328 独立审查:线下标书没有生成链路,chapters 由上传文件确定性解析而来
    bid_files = run_input.get("bid_file_keys") or (
        [run_input["bid_file_key"]] if run_input.get("bid_file_key") else []
    )
    if not chapters_src and bid_files:
        chapters_src, scanned = await parse_bid_docs(bid_files, ctx)
        # 审查修正：解析为空（扫描件/图片 PDF 提不出文字）绝不能拿空文档去跑计费审查——
        # run 直接失败,App 侧 settleFailed 全额退款,错误文案告知原因。
        # 文案按 OCR 是否配置分流：这套环境**部署了**识别服务却一个字都没拿到,那是服务当时不可用
        # 或识别失败,不是「本产品不支持扫描件」——照旧文案讲的话,用户会以为传什么都没用而放弃,
        # 实际上重试一次就好了。没部署识别服务时,原文案才是事实。
        if not chapters_src:
            raise RuntimeError(
                "扫描页识别服务暂时不可用，未能从上传的标书中提取到正文，请稍后重试"
                if ocr_configured() else
                "上传的标书未能解析出任何正文（扫描件/图片版暂不支持），请上传可复制文字的 docx/pdf 后重试")
    # 删章留下的孤儿键（chapters 是合并通道）不该被体检：那是不会交付的内容，
    # 报出来的风险用户在文档里根本找不到。无提纲的线下审查项目原样放行。
    filtered = chapters_in_outline(chapters_src, state.get("outline") or {})
    # 只拦"**被过滤清空**"这一种：本来就没有正文的场景（自查/空提纲）上面已有各自的处理，
    # 一刀切会把它们一起误杀。过滤清空 = 正文与提纲对不上，拿空文档跑计费步骤等于骗钱。
    if chapters_src and not filtered:
        raise RuntimeError("投标正文与提纲章节对不上（提纲可能已改动），请重新生成正文后再审查")
    return filtered, scanned


# 「看不见的页」类发现的标题前缀（与 SCAN_REVIEW_RULE 第 2 条的写法一致）。
_SCAN_TITLE_PREFIX = "无法核验（扫描件）"


def _force_scan_level(risk: dict) -> None:
    """把「无法核验（扫描件）」类发现强制压成中风险并重算计数（就地改 risk）。

    判定纪律写在提示词里，落库的等级却不能只靠模型自觉——同 RiskReport._derive_counts
    「计数一律推导、不信模型口头」的纪律。一条假的高风险足以让用户以为这份标书要废标，
    跑去重做一份其实就印在扫描页上的材料。
    计数必须跟着改：high/mid 是模型提交时按当时的 level 推出来的，改了等级不重算就留旧账。"""
    hit = False
    for item in risk.get("items") or []:
        if str(item.get("title") or "").startswith(_SCAN_TITLE_PREFIX):
            hit = item.get("level") != "中风险" or item.get("tone") != "warning" or hit
            item["level"], item["tone"] = "中风险", "warning"
    if hit:
        items = risk.get("items") or []
        risk["high"] = sum(1 for i in items if i.get("level") == "高风险")
        risk["mid"] = sum(1 for i in items if i.get("level") == "中风险")


def _finalize_risk(result, category: dict, self_detected: bool, scanned: list[dict]) -> dict:
    """模型提交的报告 → 落库的 risk dict：两个 sidecar + 扫描页判定纪律。

    与 read 节点同理：分类并进结果 dict，**不进 submit_risk_report 的工具 schema**。
    只有本节点现判出来的才落库当判定值——回显用户的选择会让它被当成系统判定（见 _resolve_category）。
    扫描页统计同样是 sidecar（同 bid_category 手法）：报告页据此提示「有 N 页没看到，
    相关结论请人工复核」——只有模型知道这个事实、用户看不见的话，一份大半是扫描件的标书
    会被当成一份完整审查过的标书。没有看不见的页时不带这个键，既有项目的结果结构逐字节不变。"""
    risk = result.model_dump()
    if self_detected:
        risk["bid_category"] = category
    if scanned:
        _force_scan_level(risk)
        risk["scanned_files"] = scanned
    return risk


def make_review_node(ctx):
    """graph 节点：读 read+outline+chapters 比对 → 产 RiskReport → 写 state['risk']；模型未提交即失败（可重试）。
    read 走 slim_read 裁 source_quote；章节正文按 _CHAPTER_CAP 截断（防超窗）；
    read.required_structure 非空时一并注入（spec321，供构成覆盖比对），为空时 payload 与此前一致。"""
    async def review_node(state):
        await publish_phase(ctx, _PHASE)
        # 选包时读标收窄到该包(spec324 优化):审查只比对该包要求,不会把别包的要求误判成缺失。
        read_state = filter_read_by_package(state.get("read") or {}, state.get("run_input"))
        run_input = state.get("run_input") or {}
        chapters_src, scanned = await _resolve_chapters(ctx, state, run_input)
        # 阶段名回位：扫描页 OCR 期间横幅被"识别《x》的扫描页 N/N"顶掉，之后是长达数分钟的
        # 模型调用，不把它换回来的话，用户会一直看着一个已经结束的阶段。
        await publish_phase(ctx, _PHASE)
        # 截断前先压实成紧凑文本：图片换占位符（一张 base64 就有二十万字符，2026-08-06 用户反馈
        # 「证照放进正文、审查却报缺件」的真因），HTML 标签与实体一并剥掉——2026-08-07 全量实测
        # 喂进去的字符有 **56% 是标签**，有一章正文才 5261 字、本可整章放下，却因表格标签把串撑到
        # 38431，模型只读到 561 字（10%）。表格结构保留成「单元格 | 单元格 / 换行」，
        # 因为审查要靠表格行判断★条款有没有逐条登进偏离表。
        texts = {cid: html_to_review_text(html) for cid, html in chapters_src.items()}
        # 分类判定（spec334）：**在审查之前**做，这一轮就能用上分类知识——放到审查之后的话，
        # 用户看到分类时报告已经出完，得再花一次钱重跑才生效。
        # 有读标结论的项目在读标步已判过，这里不重复判；用户确认过的值优先。
        # 用未截断的 texts 判：分类只取每章开头若干字（_chapters_summary 自带上限），不吃预算。
        category, self_detected = await _resolve_category(ctx, run_input, read_state, texts)
        # 读标结论先压进额度的一半：实测最大一份 210311 tokens（2747 个条目），
        # 单它一个就是窗口的两倍，这种项目光截正文没有用。★条款与废标风险条一条不动。
        payload = {"read": compress_read(slim_read(read_state), chapters_budget(ctx, "")),
                   "outline": state.get("outline") or {},
                   "chapters": {}}     # chapters 占位保住键序，额度算完再填
        structure = read_state.get("required_structure") or []
        if structure:
            payload["required_structure"] = structure
        mode_note = "" if read_state else _SELF_CHECK_NOTE
        # 受审文件有扫描图片页时才加这两段：判定纪律进系统提示（与其它规则同处），
        # 页数说明进用户消息最前（紧挨着材料）。没有扫描页 → 两者皆为空串，提示词逐字节不变。
        system = REVIEW_SYSTEM_PROMPT + (SCAN_REVIEW_RULE if scanned else "")
        scan_note = scan_pages_note(scanned)
        # 分类必查项（spec334）：**主次类别都取**——查多了只多看一眼，漏一条是废标。
        # 行业资质补丁在读标条目（有招标文件）或标书正文（自查）上做字面匹配，不拿全文匹配：
        # 补丁词是资质类术语，只出现在需求与资格条款里，全文匹配只增噪声和成本。
        # 判据用 read_state 而不是 payload["read"]：slim_read({}) 回的是
        # {"project_meta": {}, "categories": [], ...}——**非空 dict 恒为真**，
        # 写成 `payload["read"] or texts` 就永远取不到正文，自查项目的资质补丁静默全失效。
        extra = category_scope(category.get("value"), "review")
        # 匹配用**未压缩**的读标结论：资质术语藏在条目的 title/value 里，而压缩会把普通条目的
        # 取值截短甚至整条丢掉——恰恰是需要压缩的大标书，行业必查项会静默失效（漏一条即废标）。
        # 字面匹配不花 token，用全量没有代价。
        extra += industry_patches(json.dumps(slim_read(read_state) if read_state else texts,
                                             ensure_ascii=False))
        # 正文额度按剩余窗口算：固定部分（系统提示 + 读标结论 + 约束文字）先占，剩下的才是正文的。
        # 写死常量的下场见 chapters_budget 的注释——砍不够是 400，砍过头是白丢内容。
        fixed = system + scan_note + json.dumps(payload, ensure_ascii=False) + mode_note + extra
        budget = chapters_budget(ctx, fixed)
        # 固定部分（读标结论 + 提示词 + schema）本身就撑满窗口：正文一个字都放不下。
        # 这种载荷缩多少轮都装不进去，与其白烧三轮 400，不如当场失败——App 侧全额退款。
        if budget < MIN_CHAPTER_CHARS:
            raise RuntimeError("招标文件的解析结果过大，超出模型可处理的长度；"
                               "请在「招标解读」页选择本次投标的包件后重试")

        async def _attempt(factor: float):
            """按给定折扣重建载荷再跑——估算失准时由 run_with_shrink 逐档收缩。"""
            payload["chapters"] = allocate_chapter_budget(
                texts, int(budget * factor), MIN_CHAPTER_CHARS)
            user = (f"{scan_note}招标与投标材料：\n{json.dumps(payload, ensure_ascii=False)}{mode_note}"
                    f"\n请审查并提交体检报告。{extra}")
            return await run_submit_agent(
                ctx, system, user,
                "submit_risk_report", RiskReport, "提交审查报告")

        result = await run_with_shrink(_attempt, label="审查")
        return {"risk": _finalize_risk(result, category, self_detected, scanned)}
    return review_node
