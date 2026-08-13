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
    user_msg = gw.chats[-1].last_messages[1].content
    assert "required_structure" not in user_msg


def test_review_node_with_required_structure_injects_payload(submit_gateway):
    """read.required_structure 非空 → 注入用户消息，供审查比对构成覆盖。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_review_node(ctx)
    state = {"read": {"risk_summary": [], "required_structure": _REQUIRED_STRUCTURE},
             "outline": {"chapters": []}, "chapters": {}}
    asyncio.run(node(state))
    user_msg = gw.chats[-1].last_messages[1].content
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
    user_msg = gw.chats[-1].last_messages[-1].content
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
    system_msg = gw.chats[-1].last_messages[0].content
    user_msg = gw.chats[-1].last_messages[-1].content
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
    assert gw.chats[-1].last_messages[0].content == REVIEW_SYSTEM_PROMPT
    assert gw.chats[-1].last_messages[-1].content.startswith("招标与投标材料：")


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
    system_msg = gw.chats[-1].last_messages[0].content
    user_msg = gw.chats[-1].last_messages[-1].content
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
    user_msg = gw.chats[-1].last_messages[-1].content
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
    user_msg = gw.chats[-1].last_messages[1].content
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
    system_msg = gw.chats[-1].last_messages[0].content
    assert "【渲染恒定项】" in system_msg
    assert "封面、目录、投标人承诺与签章页、AI 生成说明页" in system_msg
    assert "已具备(导出恒定附加)" in system_msg


def test_review_feeds_everything_when_it_fits(submit_gateway):
    """放得下就一个字都不砍。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)(
        {"read": {"risk_summary": []}, "outline": {},
         "chapters": {"b1": "<p>" + "正文" * 500 + "结尾标记</p>"}}))
    user_msg = gw.chats[-1].last_messages[1].content
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
    note = scan_pages_note([{"name": "响应文件.doc", "embedded_images": 1, "recognized_images": 10}])
    assert "11 张内嵌图片" in note
    assert "10 张已识别为文字" in note and "视同可见" in note
    assert "1 张" in note and "不可见" in note
    # 全识别:不再扣「内容不可见」帽子,只指路识别文字
    clean = scan_pages_note([{"name": "响应文件.doc", "embedded_images": 0, "recognized_images": 11}])
    assert "不可见" not in clean
    assert "11 张已识别为文字" in clean
