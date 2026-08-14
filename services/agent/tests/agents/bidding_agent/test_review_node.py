import asyncio

import pytest

from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.review import make_review_node


_RISK_ARGS = {
    "score": 78, "high": 1, "mid": 0, "passed": 5,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★）",
               "advice": "补证书否则废标", "target_tab": "business", "target_id": "b4",
               "anchor_text": "ISO27001 认证证书复印件"}],
    "passed_items": ["报价未超限价"],
}


def _review_chat(gw):
    """按系统提示认出**审查轮**的 chat：复核轮（2026-08-13）上线后 chats[-1] 是复核轮，
    按位置取会拿错轮；按内容认不受后续再加轮次影响。"""
    return next(c for c in gw.chats if c.last_messages and "投标合规审查专家" in c.last_messages[0].content)


def test_review_node_flags_iso_high_risk(submit_gateway):
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_risk_report": _RISK_ARGS}))
    node = make_review_node(ctx)
    out = asyncio.run(node({
        "read": {"risk_summary": ["缺 ISO27001 即废标"]},
        "outline": {"chapters": [{"id": "b4", "no": "第四章", "title": "企业资质", "group": "business"}]},
        "chapters": {"b4": "<h3>4.1 营业执照与体系认证</h3><p>已通过 ISO9001…</p>"},
    }))
    risk = out["risk"]
    assert risk["high"] == 1
    assert risk["items"][0]["target_id"] == "b4" and risk["items"][0]["tone"] == "destructive"


_REQUIRED_STRUCTURE = [{"id": "s1", "title": "投标报价一览表", "kind": "form", "required": True}]


def test_review_node_without_required_structure_payload_unchanged(submit_gateway):
    """read.required_structure 为空/缺失 → 用户消息与今天字节级一致（向后兼容，spec321）。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_review_node(ctx)
    state = {"read": {"risk_summary": ["缺 ISO27001 即废标"]},
             "outline": {"chapters": [{"id": "b4", "no": "第四章", "title": "企业资质", "group": "business"}]},
             "chapters": {"b4": "<h3>4.1 营业执照</h3>"}}
    asyncio.run(node(state))
    user_msg = _review_chat(gw).last_messages[1].content
    assert "required_structure" not in user_msg


def test_review_node_with_required_structure_injects_payload(submit_gateway):
    """read.required_structure 非空 → 注入用户消息，供审查比对构成覆盖。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_review_node(ctx)
    state = {"read": {"risk_summary": [], "required_structure": _REQUIRED_STRUCTURE},
             "outline": {"chapters": []}, "chapters": {}}
    asyncio.run(node(state))
    user_msg = _review_chat(gw).last_messages[1].content
    assert "required_structure" in user_msg and "投标报价一览表" in user_msg


def test_review_node_parses_external_bid_when_no_chapters(submit_gateway, monkeypatch):
    """spec328 独立审查：chapters 空 + run_input.bid_file_key → 确定性解析上传标书成章;
    read 为空 → 注入通用自查口径（明示未对照招标文件）。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    from agent.parsing.types import ParsedDoc

    parsed = ParsedDoc(text="全文", kind="docx", clauses=[
        {"id": "sec-1-c1", "text": "第一部分正文A"},
        {"id": "sec-1-c2", "text": "第一部分正文B"},
        {"id": "sec-2-c1", "text": "报价合计 100 万元"},
    ])
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: parsed)
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_review_node(ctx)
    out = asyncio.run(node({"run_input": {"bid_file_key": "uploads/u/bid.docx"}}))
    assert out["risk"]["high"] == 1
    user_msg = _review_chat(gw).last_messages[-1].content
    assert "第一部分正文A" in user_msg and "报价合计 100 万元" in user_msg  # 解析出的章进了审查材料
    assert "通用自查模式" in user_msg and "未提供招标文件" in user_msg      # 无 read → 明示局限


def test_review_node_notes_scanned_pages_and_bans_missing_high_risk(submit_gateway, monkeypatch):
    """2026-08-09 生产实测：366 页标书里 139 页是扫描件（身份证/授权书/盖章报价表），文字提不出来，
    审查便把**实际存在**的材料判成「缺少」高风险。诚实分级：告诉模型有多少页它看不见，
    并要求这类判定降为「无法核验(扫描件)」中风险。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    from agent.parsing.types import ParsedDoc

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: ParsedDoc(
        text="投标函", kind="pdf", pages=366, image_pages=139,
        clauses=[{"id": "sec-1-c1", "text": "投标函正文"}]))
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)({"run_input": {"bid_file_key": "uploads/u/x/投标文件.pdf"}}))
    system_msg = _review_chat(gw).last_messages[0].content
    user_msg = _review_chat(gw).last_messages[-1].content
    # 文件可见性说明进用户消息：多少页、多少页看不见、里面很可能是什么
    assert "投标文件.pdf" in user_msg and "366" in user_msg and "139" in user_msg
    assert "扫描图片页" in user_msg and "证照" in user_msg
    # 判定纪律进系统提示：看不见的一律降为中风险，且不出现内部字段名
    assert "无法核验（扫描件）" in system_msg and "中风险" in system_msg
    assert "image_pages" not in system_msg and "image_pages" not in user_msg


def test_review_node_without_scanned_pages_keeps_prompt_unchanged(submit_gateway, monkeypatch):
    """文件全是可复制文字 → 提示词与此前逐字节一致（系统提示不加料、用户消息不加前缀），
    「缺少」高风险照判不误。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    from agent.agents.bidding_agent.prompts.review import REVIEW_SYSTEM_PROMPT
    from agent.parsing.types import ParsedDoc

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: ParsedDoc(
        text="投标函", kind="pdf", pages=10, image_pages=0,
        clauses=[{"id": "sec-1-c1", "text": "投标函正文"}]))
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)({"run_input": {"bid_file_key": "uploads/u/x/bid.pdf"}}))
    assert _review_chat(gw).last_messages[0].content == REVIEW_SYSTEM_PROMPT
    assert _review_chat(gw).last_messages[-1].content.startswith("招标与投标材料：")


def _scanned_doc(pages: int = 366, image_pages: int = 139):
    """一份「有正文、也有看不见的扫描页」的解析结果（数量取自 2026-08-09 的生产样本）。"""
    from agent.parsing.types import ParsedDoc
    return ParsedDoc(text="投标函", kind="pdf", pages=pages, image_pages=image_pages,
                     clauses=[{"id": "sec-1-c1", "text": "投标函正文"}])


def test_scan_rule_overrides_every_missing_equals_high_risk_rule():
    """扫描页判定纪律必须盖住**所有**「缺失即高风险」的条款。漏掉第 5 条（格式红线缺章）时，
    印在扫描页上的偏离表/报价一览表照旧被判成高风险缺章——正是这条规则要消灭的假阳性。"""
    from agent.agents.bidding_agent.prompts.review import SCAN_REVIEW_RULE
    header = SCAN_REVIEW_RULE.strip().splitlines()[0]
    for rule_no in ("1", "5", "6", "7"):
        assert rule_no in header, f"第 {rule_no} 条也判「缺失即高风险」，必须被扫描页规则覆盖"


def test_unreadable_bid_blames_the_ocr_service_when_it_is_configured(submit_gateway, monkeypatch):
    """OCR 已配置却一个字都没解析出来 = 识别服务当时不可用/识别失败，不是「本产品不支持扫描件」。
    照旧文案讲的话，用户会以为传什么都没用而放弃，实际上重试一次就好了。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    from agent.parsing import ocr as ocr_mod
    from agent.parsing.types import ParsedDoc

    monkeypatch.setattr(ocr_mod.settings, "ocr_base_url", "http://ocr.test:8100")
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="", kind="pdf", pages=8, image_pages=8))
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    with pytest.raises(RuntimeError) as ei:
        asyncio.run(make_review_node(ctx)({"run_input": {"bid_file_key": "uploads/u/x/bid.pdf"}}))
    msg = str(ei.value)
    assert "暂不支持" not in msg
    assert "暂时不可用" in msg and "重试" in msg
    assert gw.chats == []            # 计费轮一轮都没烧（run 失败 → App 侧全额退款）


def test_unreadable_bid_keeps_the_unsupported_wording_when_ocr_is_off(submit_gateway, monkeypatch):
    """没部署 OCR 的环境里，「扫描件/图片版暂不支持」就是事实——文案原样保留，让用户去换文件。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    from agent.parsing import ocr as ocr_mod
    from agent.parsing.types import ParsedDoc

    monkeypatch.setattr(ocr_mod.settings, "ocr_base_url", "")
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="", kind="pdf", pages=8, image_pages=8))
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    with pytest.raises(RuntimeError) as ei:
        asyncio.run(make_review_node(ctx)({"run_input": {"bid_file_key": "uploads/u/x/bid.pdf"}}))
    assert "扫描件/图片版暂不支持" in str(ei.value)


_SCAN_TITLE = "无法核验（扫描件）：法定代表人身份证明"


def test_unverifiable_findings_are_forced_down_to_mid_risk(submit_gateway, monkeypatch):
    """判定纪律写在提示词里，落库的等级却不能只靠模型自觉（同 _derive_counts「不信模型口头」）：
    模型把「无法核验（扫描件）」条目判成高风险时强制降级，并重算计数——一条假的高风险
    足以让用户以为这份标书要废标，跑去重做一份本来就印在扫描页上的材料。"""
    import agent.agents.bidding_agent.nodes.common as common_mod

    args = {**_RISK_ARGS, "high": 2, "mid": 0,
            "items": [_RISK_ARGS["items"][0],
                      {**_RISK_ARGS["items"][0], "title": _SCAN_TITLE,
                       "level": "高风险", "tone": "destructive"}]}
    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: _scanned_doc())
    gw = submit_gateway({"submit_risk_report": args})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    risk = asyncio.run(make_review_node(ctx)(
        {"run_input": {"bid_file_key": "uploads/u/x/投标文件.pdf"}}))["risk"]
    forced = [i for i in risk["items"] if i["title"] == _SCAN_TITLE][0]
    assert forced["level"] == "中风险" and forced["tone"] == "warning"
    assert risk["high"] == 1 and risk["mid"] == 1        # 计数跟着改，不留旧账
    assert risk["items"][0]["level"] == "高风险"          # 真高风险一条都不许被牵连


def test_review_result_carries_the_scanned_stats_for_the_report_banner(submit_gateway, monkeypatch):
    """扫描页统计随结果落库（sidecar，同 bid_category 手法）：报告页要据此提示
    「有 N 页没看到，相关结论请人工复核」。只在真有看不见的页时带上，其余项目结果逐字节不变。"""
    import agent.agents.bidding_agent.nodes.common as common_mod

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: _scanned_doc())
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    risk = asyncio.run(make_review_node(ctx)(
        {"run_input": {"bid_file_key": "uploads/u/x/投标文件.pdf"}}))["risk"]
    assert risk["scanned_files"] == [
        {"name": "投标文件.pdf", "pages": 366, "image_pages": 139}]

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: _scanned_doc(image_pages=0))
    clean = asyncio.run(make_review_node(ctx)(
        {"run_input": {"bid_file_key": "uploads/u/x/投标文件.pdf"}}))["risk"]
    assert "scanned_files" not in clean


def test_docx_embedded_images_get_the_same_honest_notice_as_scanned_pages(
        submit_gateway, monkeypatch):
    """docx 正文里贴的证照/盖章图对模型同样是"看不见的材料"，只是没有「页」的口径。
    不告诉模型的话，docx 版标书照旧被判「缺少某材料」——扫描 PDF 那条治理白做了一半。
    要求：张数说明进用户消息、判定纪律（无法核验/中风险）进系统提示、统计随结果落库。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    from agent.parsing.types import ParsedDoc

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: ParsedDoc(
        text="投标函", kind="docx", embedded_images=7,
        clauses=[{"id": "sec-1-c1", "text": "投标函正文"}]))
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    risk = asyncio.run(make_review_node(ctx)(
        {"run_input": {"bid_file_key": "uploads/u/x/商务标.docx"}}))["risk"]
    system_msg = _review_chat(gw).last_messages[0].content
    user_msg = _review_chat(gw).last_messages[-1].content
    assert "商务标.docx" in user_msg and "7" in user_msg and "内嵌图片" in user_msg
    assert "无法核验（扫描件）" in system_msg
    assert "embedded_images" not in system_msg and "embedded_images" not in user_msg
    assert risk["scanned_files"] == [{"name": "商务标.docx", "embedded_images": 7}]


def test_review_node_with_tender_and_bid_file_uses_compare_mode(submit_gateway, monkeypatch):
    """带招标文件（read 非空）时即便 chapters 来自解析,也走对照口径（不注入通用自查说明）。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    from agent.parsing.types import ParsedDoc
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="响应正文", kind="docx",
                                              clauses=[{"id": "sec-1-c1", "text": "响应正文"}]))
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_review_node(ctx)
    asyncio.run(node({"read": {"risk_summary": ["缺 ISO27001 即废标"]},
                      "run_input": {"bid_file_key": "uploads/u/bid.docx"}}))
    user_msg = _review_chat(gw).last_messages[-1].content
    assert "响应正文" in user_msg
    assert "通用自查模式" not in user_msg


def test_review_caps_the_bid_text_it_feeds_the_model(submit_gateway):
    """审查同样要受窗口约束——不然大标书一样是 400 整步失败。

    断言真正的不变式：整条输入 + 输出配额装得进窗口。不断言具体字数，额度是动态算的。
    """
    from agent.framework.budget import (
        DEFAULT_CONTEXT_WINDOW, _DEFAULT_OUTPUT_RESERVE, estimate_tokens)
    from agent.agents.bidding_agent.prompts.review import REVIEW_SYSTEM_PROMPT

    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    huge = {f"b{i}": f"<p>{'投标内容' * 20000}</p>" for i in range(1, 9)}   # 约 64 万字
    asyncio.run(make_review_node(ctx)({"read": {"risk_summary": []}, "outline": {}, "chapters": huge}))
    user_msg = _review_chat(gw).last_messages[1].content
    total = estimate_tokens(REVIEW_SYSTEM_PROMPT + user_msg) + _DEFAULT_OUTPUT_RESERVE
    assert total < DEFAULT_CONTEXT_WINDOW, f"整条输入 {total} tokens，装不进窗口"


def test_review_system_prompt_notes_render_time_constants(submit_gateway):
    """spec②:渲染恒定项（封面/目录/承诺签章页/AI 说明页）常驻系统提示——审查不该把这些
    恒定附加项判成缺失。放系统提示（而非拼进用户消息）：这条规则不随 state 变化，
    REVIEW_SYSTEM_PROMPT 本就是 fixed 预算计算的一部分，扩它无需再改 review.py 的载荷组装。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_review_node(ctx)
    asyncio.run(node({
        "read": {"risk_summary": []},
        "outline": {"chapters": []},
        "chapters": {},
    }))
    system_msg = _review_chat(gw).last_messages[0].content
    assert "【渲染恒定项】" in system_msg
    assert "目录、投标人承诺与签章页、AI 生成说明页" in system_msg
    # 2026-08-14 实测:「缺响应文件封面」被报成高风险——封面别名必须点名进恒定项
    assert "响应文件封面" in system_msg
    assert "已具备(导出恒定附加)" in system_msg


def test_review_feeds_everything_when_it_fits(submit_gateway):
    """放得下就一个字都不砍。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)(
        {"read": {"risk_summary": []}, "outline": {},
         "chapters": {"b1": "<p>" + "正文" * 500 + "结尾标记</p>"}}))
    user_msg = _review_chat(gw).last_messages[1].content
    assert "结尾标记" in user_msg and "【系统注记·截断】" not in user_msg


def test_recognized_image_text_counts_as_visible_content():
    """识别文字视同可见（2026-08-13 实测：11 张识别了 10，审查仍写「营业执照以图片识别
    形式呈现，内容不可见」——自相矛盾的四条假无法核验）。两处必须同时在场：
    规则里明写识别文字按确认处理、可见性说明分开报「已识别 M 张（可核验）/剩 K 张不可见」。"""
    from agent.agents.bidding_agent.prompts.review import SCAN_REVIEW_RULE, scan_pages_note

    assert "识别文字视同可见正文" in SCAN_REVIEW_RULE
    # 2026-08-13 二轮实测：识别都用上了，标题仍写「身份证原件扫描件无法核验」的大帽子，
    # 且把"签章栏空白"这个看得见的事实塞进无法核验——两条配套纪律必须在场
    assert "标题只冠核不了的那个维度" in SCAN_REVIEW_RULE
    assert "识别文字里看得见的问题走正常判定" in SCAN_REVIEW_RULE
    # 条件豁免（2026-08-13 实测）：模板明写「法定代表人参加采购，不用提供授权书」，
    # 审查却对着授权书空白喊"须签章否则不过"——豁免条款必须进判定
    assert "条件豁免条款" in SCAN_REVIEW_RULE and "不用提供授权书" in SCAN_REVIEW_RULE
    # 综合判断（2026-08-13 实测）：四张身份证识别齐全、授权书正文已填，报告却让人工核对
    # "正反面是否完整"——图识别文字与正文必须合并清点后再下结论
    assert "识别文字与正文合并成一个判断" in SCAN_REVIEW_RULE
    assert "先清点再下结论" in SCAN_REVIEW_RULE
    note = scan_pages_note([{"name": "响应文件.doc", "embedded_images": 1, "recognized_images": 10}])
    assert "11 张内嵌图片" in note
    assert "10 张已识别为文字" in note and "视同可见" in note
    assert "1 张" in note and "不可见" in note
    # 全识别:不再扣「内容不可见」帽子,只指路识别文字
    clean = scan_pages_note([{"name": "响应文件.doc", "embedded_images": 0, "recognized_images": 11}])
    assert "不可见" not in clean
    assert "11 张已识别为文字" in clean


def test_review_scope_is_presence_and_content_not_carrier_attributes():
    """2026-08-14 用户拍板：审查重心＝材料有没有、内容对不对；「是否原件彩色扫描/印章签字
    真伪/骑缝章/截图覆盖维度/查询日期有效期」这类载体属性不是审查职责——上一版报告 6 条
    无法核验里 3 条是这类（营业执照/财务报表/信用中国内容明明识别齐全），用户体感＝审查
    看不见材料。复核官同样要认这条：超出职责的发现直接撤。"""
    from agent.agents.bidding_agent.prompts.review import (
        REVIEW_VERIFY_PROMPT, SCAN_REVIEW_RULE)

    assert "审查重心" in SCAN_REVIEW_RULE
    assert "载体属性" in SCAN_REVIEW_RULE
    assert "有没有" in SCAN_REVIEW_RULE and "对不对" in SCAN_REVIEW_RULE
    # 图片上的章几乎不会被识别成文字：「识别文字里没见到章」不构成「未盖章」的证据
    # （2026-08-14 实测：承诺函识别文字未见公章 → 被报成"盖章真伪无法核验，若确无则须补盖"）
    assert "不构成" in SCAN_REVIEW_RULE
    # 旧口径的残留必须清干净：载体属性维度不再「保留无法核验」
    assert "才保留「无法核验」" not in SCAN_REVIEW_RULE
    # 复核官新增反驳方向：超出审查职责（载体属性）→ drop
    assert "超出审查职责" in REVIEW_VERIFY_PROMPT


_TWO_FINDINGS = {
    "score": 60, "items": [
        {"level": "中风险", "tone": "warning", "title": "无法核验（扫描件）：营业执照原件扫描件",
         "advice": "内容不可见请人工核对", "target_id": "b4", "target_tab": "business",
         "tender_ref": "对应：资格要求", "chapter_title": "资格文件", "anchor_text": "营业执照"},
        {"level": "高风险", "tone": "destructive", "title": "授权书签章空白",
         "advice": "须签章", "target_id": "b4", "target_tab": "business",
         "tender_ref": "对应：授权书（★）", "chapter_title": "资格文件", "anchor_text": "签章"}],
    "passed_items": [],
}


def test_verify_pass_drops_and_revises_findings(submit_gateway):
    """复核轮（2026-08-13 用户点单）：drop 的发现移出并进通过项（带撤销理由），
    revise 的按新级别/文案改写，计数由 _derive_counts 按新列表重推。"""
    verdicts = {"verdicts": [
        {"index": 1, "verdict": "drop", "echo_title": "无法核验（扫描件）：营业执照原件扫描件",
         "reason": "识别文字含统一社会信用代码91310104MA1FRF3K3N，材料已具备", "level": "", "title": "", "advice": ""},
        {"index": 2, "verdict": "revise", "echo_title": "授权书签章空白", "reason": "属实但属条件豁免范围",
         "level": "中风险", "title": "授权书签章空白（若法定代表人亲自参加则无需授权书）",
         "advice": "若由全权代表参加须补签章；法定代表人亲自参加则本项免除"},
        # 越界/串号/坏级别的三条防御性结论：都只作废自己，不作废整批（评审 2026-08-13）
        {"index": 3, "verdict": "drop", "echo_title": "不存在的发现", "reason": "越界", "level": "", "title": "", "advice": ""}]}
    gw = submit_gateway({"submit_risk_report": _TWO_FINDINGS, "submit_review_verdicts": verdicts})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    out = asyncio.run(make_review_node(ctx)({
        "read": {"risk_summary": ["x"]},
        "outline": {"chapters": [{"id": "b4", "no": "四", "title": "资格文件", "group": "business"}]},
        "chapters": {"b4": "<p>正文【系统注记·图片识别 第1张】统一社会信用代码91310104MA1FRF3K3N</p>"},
    }))
    risk = out["risk"]
    assert len(risk["items"]) == 1
    assert risk["items"][0]["level"] == "中风险" and risk["items"][0]["tone"] == "warning"
    assert "条件豁免" not in risk["items"][0]["title"] or "免除" in risk["items"][0]["advice"]
    assert risk["high"] == 0 and risk["mid"] == 1
    assert any("复核撤销" in p for p in risk["passed_items"])


def test_verify_pass_failure_keeps_the_first_report(submit_gateway):
    """复核是减法：复核轮拿不到结论（桩里没配该工具→当轮报错）→ 首轮报告原样交付。"""
    gw = submit_gateway({"submit_risk_report": _TWO_FINDINGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    out = asyncio.run(make_review_node(ctx)({
        "read": {"risk_summary": ["x"]},
        "outline": {"chapters": [{"id": "b4", "no": "四", "title": "资格文件", "group": "business"}]},
        "chapters": {"b4": "<p>正文</p>"},
    }))
    assert len(out["risk"]["items"]) == 2, "复核垮了不能连累审查交付"


def test_verify_prompt_is_subtraction_only():
    """复核官纪律：只做减法(不得新增发现)、拿不准 keep、drop/revise 必须引材料原文。"""
    from agent.agents.bidding_agent.prompts.review import REVIEW_VERIFY_PROMPT
    assert "不得新增发现" in REVIEW_VERIFY_PROMPT
    assert "拿不准就 keep" in REVIEW_VERIFY_PROMPT
    assert "找反证" in REVIEW_VERIFY_PROMPT


def test_verify_verdict_defenses(submit_gateway):
    """复核结论逐条防御（2026-08-13 评审 CONFIRMED×3）：坏级别只废该项修改不废整批、
    echo_title 对不上按 keep、reason 里引用的【系统注记…】被清洗（否则撤销审计条
    会被 _derive_counts 的注记闸静默吞掉）。"""
    verdicts = {"verdicts": [
        {"index": 1, "verdict": "drop", "echo_title": "无法核验（扫描件）：营业执照原件扫描件",
         "reason": "识别文字（【系统注记·图片识别 第1张】后）含统一社会信用代码，材料已具备",
         "level": "", "title": "", "advice": ""},
        {"index": 2, "verdict": "revise", "echo_title": "完全对不上的标题",
         "reason": "串号了", "level": "低风险", "title": "x", "advice": "y"}]}
    gw = submit_gateway({"submit_risk_report": _TWO_FINDINGS, "submit_review_verdicts": verdicts})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    out = asyncio.run(make_review_node(ctx)({
        "read": {"risk_summary": ["x"]},
        "outline": {"chapters": [{"id": "b4", "no": "四", "title": "资格文件", "group": "business"}]},
        "chapters": {"b4": "<p>正文</p>"},
    }))
    risk = out["risk"]
    # 第 1 条 drop 生效且撤销条**活着**（注记引用被洗成「识别文字」，没被注记闸吞）
    assert any("复核撤销" in p and "识别文字" in p for p in risk["passed_items"]), \
        "撤销审计条被注记闸吞了——reason 里的【系统注记】没洗"
    # 第 2 条 echo 对不上 → 按 keep：高风险原样保留，坏级别「低风险」没有炸掉整批
    assert len(risk["items"]) == 1
    assert risk["items"][0]["title"] == "授权书签章空白" and risk["items"][0]["level"] == "高风险"


def test_verify_system_prompt_carries_note_discipline():
    """复核官必须识得系统注记（评审 CONFIRMED：split 摘规则块恒为空的静默空操作——
    复核官把【系统注记】当投标内容判，2026-08-11 事故在复核轮重演）。"""
    from agent.agents.bidding_agent.prompts.review import verify_system_prompt
    assert "【系统注记" in verify_system_prompt(False)
    assert "看不见的内容怎么判" in verify_system_prompt(True)
    assert "看不见的内容怎么判" not in verify_system_prompt(False)


def test_force_scan_level_covers_any_cannot_verify_bracket():
    """「无法核验」强制降级不认括注（评审 CONFIRMED：只认（扫描件）时，
    新式「无法核验（需人工）」标题带着假高风险漏过降级闸）。"""
    from agent.agents.bidding_agent.nodes.review import _force_scan_level
    risk = {"items": [
        {"title": "无法核验（需人工）：授权书签字盖章真伪", "level": "高风险", "tone": "destructive"},
        {"title": "无法核验（扫描件）：剩余1张图", "level": "高风险", "tone": "destructive"}],
        "high": 2, "mid": 0}
    _force_scan_level(risk)
    assert all(i["level"] == "中风险" and i["tone"] == "warning" for i in risk["items"])
    assert risk["high"] == 0 and risk["mid"] == 2
