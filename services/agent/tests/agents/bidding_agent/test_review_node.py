import asyncio
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.review import make_review_node


_RISK_ARGS = {
    "score": 78, "high": 1, "mid": 0, "passed": 5,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★）",
               "advice": "补证书否则废标", "target_tab": "business", "target_id": "b4", "anchor_text": "ISO27001 认证证书复印件"}],
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

    class _Parsed:
        clauses = [
            {"id": "sec-1-c1", "text": "第一部分正文A"},
            {"id": "sec-1-c2", "text": "第一部分正文B"},
            {"id": "sec-2-c1", "text": "报价合计 100 万元"},
        ]

    monkeypatch.setattr(common_mod, "read_and_parse", lambda key: _Parsed())
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_review_node(ctx)
    out = asyncio.run(node({"run_input": {"bid_file_key": "uploads/u/bid.docx"}}))
    assert out["risk"]["high"] == 1
    user_msg = gw.chats[-1].last_messages[-1].content
    assert "第一部分正文A" in user_msg and "报价合计 100 万元" in user_msg  # 解析出的章进了审查材料
    assert "通用自查模式" in user_msg and "未提供招标文件" in user_msg      # 无 read → 明示局限


def test_review_node_with_tender_and_bid_file_uses_compare_mode(submit_gateway, monkeypatch):
    """带招标文件（read 非空）时即便 chapters 来自解析,也走对照口径（不注入通用自查说明）。"""
    import agent.agents.bidding_agent.nodes.common as common_mod
    monkeypatch.setattr(common_mod, "read_and_parse",
                        lambda key: type("P", (), {"clauses": [{"id": "sec-1-c1", "text": "响应正文"}]})())
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
    assert "结尾标记" in user_msg and "（截断）" not in user_msg
