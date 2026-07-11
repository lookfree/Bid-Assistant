import asyncio
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.review import make_review_node


_RISK_ARGS = {
    "score": 78, "high": 1, "mid": 0, "passed": 5,
    "items": [{"level": "高风险", "tone": "destructive", "title": "缺少 ISO27001 认证",
               "chapter_title": "企业资质与信誉证明", "tender_ref": "对应：第二章 资格要求（★）",
               "advice": "补证书否则废标", "target_tab": "business", "target_id": "b4"}],
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
