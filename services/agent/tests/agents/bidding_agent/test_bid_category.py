"""标书分类判定（spec334 Task A）。

覆盖三条钱与正确性的守卫：分类失败不得拖垮读标/审查步；多包件不判（判定早于选包）；
模型编造的证据条款 id 必须被剔除。
"""
import asyncio

from agent.runtime.registry import RunContext
from agent.parsing.types import ParsedDoc
from agent.agents.bidding_agent.nodes import read as read_mod
from agent.agents.bidding_agent.nodes.review import make_review_node
from agent.agents.bidding_agent.schemas import BidCategory, ReadResult

_CLAUSES = [{"id": "sec-1-c1", "text": "项目名称：某某平台建设"},
            {"id": "sec-2-c1", "text": "投标人须具备 ISO27001 认证"}]

_READ_ARGS = {
    "categories": [{"key": "technical", "title": "技术需求",
                    "items": [{"title": "交货期", "value": "合同签订后 30 日内到货",
                               "clause_ids": ["sec-2-c1"]}]}],
    "risk_summary": [],
}

_CAT_ARGS = {"value": ["goods"], "confidence": "high", "reason": "采购标的为成套设备",
             "evidence_clause_ids": ["sec-2-c1"]}

_RISK_ARGS = {
    "score": 80, "items": [], "passed_items": ["报价未超限价"],
}


def _read_ctx(submit_gateway, extra: dict | None = None):
    return RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                      gateway=submit_gateway({"submit_read_result": _READ_ARGS, **(extra or {})}))


def test_read_node_attaches_bid_category(monkeypatch, submit_gateway):
    """分类随读标结果交付，且**不是 ReadResult 的字段**——它挂在结果 dict 上，
    与 doc_sections 同一条路子，绝不混进 submit_read_result 的工具 schema。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    ctx = _read_ctx(submit_gateway, {"submit_bid_category": _CAT_ARGS})
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/t.docx"}))
    assert out["read"]["bid_category"]["value"] == ["goods"]
    assert out["read"]["bid_category"]["evidence_clause_ids"] == ["sec-2-c1"]
    assert "bid_category" not in ReadResult.model_fields, "挂进 ReadResult 就等于混进读标的工具 schema"


def test_classification_failure_does_not_fail_the_read_step(monkeypatch, submit_gateway):
    """分类调用失败（模型不提交）⇒ 读标步照样成功、分类为空。
    读标是链上最贵的一步，绝不能为一次锦上添花的分类赔上整轮费用。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    ctx = _read_ctx(submit_gateway)                       # 不给 submit_bid_category ⇒ 分类必失败
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/t.docx"}))
    assert out["read"]["bid_category"]["value"] == []
    assert out["read"]["categories"], "读标结论本身必须完好"


def test_multi_package_tender_is_not_classified(monkeypatch, submit_gateway):
    """多包件不判：判定发生在用户选包之前，各包可能分属不同类别，
    拿全文判出来安到某个具体包上是错的。此时**连模型都不该调**。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    multi = {**_READ_ARGS, "packages": [{"id": "p1", "name": "包一"}, {"id": "p2", "name": "包二"}]}
    gw = submit_gateway({"submit_read_result": multi, "submit_bid_category": _CAT_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/t.docx"}))
    assert out["read"]["bid_category"]["value"] == []
    assert all("submit_bid_category" not in c.tool_names for c in gw.chats), "多包件不该发起分类调用"


def test_fabricated_evidence_clause_ids_are_dropped(monkeypatch, submit_gateway):
    """模型编造的条款 id 前端点开定位不到，比没有证据更糟——只保留摘要里真实出现过的。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    faked = {**_CAT_ARGS, "evidence_clause_ids": ["sec-2-c1", "sec-99-c9", "编的"]}
    ctx = _read_ctx(submit_gateway, {"submit_bid_category": faked})
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/t.docx"}))
    assert out["read"]["bid_category"]["evidence_clause_ids"] == ["sec-2-c1"]


def test_rerunning_read_always_refreshes_the_detection(monkeypatch, submit_gateway):
    """读标步是判定值的产地：**每次重跑都重新判**，即使 run_input 带了分类。
    跳过就意味着重跑读标再也刷不出新判定；用户的确认值另存在项目行，不受这里影响。
    （App 对 read 步本来就不下发分类，这条钉住的是「即使下发了也不许跳过」。）"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    gw = submit_gateway({"submit_read_result": _READ_ARGS, "submit_bid_category": _CAT_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    out = asyncio.run(read_mod.make_read_node(ctx)(
        {"file_key": "uploads/x/t.docx", "run_input": {"bid_category": ["services"]}}))
    assert out["read"]["bid_category"]["value"] == ["goods"]   # 重新判出来的，不是回传的
    assert any("submit_bid_category" in c.tool_names for c in gw.chats)


def test_category_value_is_deduped_and_capped_at_two():
    """1–2 个值、去重保序：模型偶尔把三类全列上或重复同一类，在数据模型层收敛成不变量，
    免得「首元素为主类别、最多两类」要在每个消费点各防一次。"""
    assert BidCategory(value=["services", "goods", "services", "engineering"]).value == ["services", "goods"]
    assert BidCategory().value == []


def test_self_check_project_classifies_from_uploaded_bid(submit_gateway):
    """自查模式（没有招标文件 ⇒ 没有读标结论）：拿上传标书正文判，且随审查结果一并回传。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS, "submit_bid_category": _CAT_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    out = asyncio.run(make_review_node(ctx)({
        "chapters": {"c1": "<h3>施工组织设计</h3><p>本工程量清单覆盖全部分部分项</p>"},
    }))
    assert out["risk"]["bid_category"]["value"] == ["goods"]
    assert any("submit_bid_category" in c.tool_names for c in gw.chats), "自查模式必须现判一次"


def test_review_reuses_the_read_verdict_but_does_not_restate_it(submit_gateway):
    """有读标结论 ⇒ 读标步已判过：审查**照用**它做注入，但**不再把它写回自己的结果**。
    回写的话，App 侧「取最近一条带分类的步结果」会把它当成新的系统判定——而它可能只是用户
    自己确认过的值，于是纠偏样本会记出系统从没做过的判错，清除确认值也会回落到用户的旧选择。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS, "submit_bid_category": _CAT_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    out = asyncio.run(make_review_node(ctx)({
        "read": {"risk_summary": [], "bid_category": {"value": ["engineering"], "confidence": "high",
                                                      "reason": "", "evidence_clause_ids": []}},
        "chapters": {"c1": "<p>正文</p>"},
    }))
    assert "bid_category" not in out["risk"], "复用来的分类不该被当成本步的判定值落库"
    assert all("submit_bid_category" not in c.tool_names for c in gw.chats), "不该重复判定"
    assert "工程标" in gw.chats[-1].last_messages[1].content, "但必须照它注入该类必查项"


def test_explicit_off_is_honoured_and_not_re_detected(submit_gateway):
    """用户明确关掉分类（下发空数组）⇒ 既不注入任何分类知识，也不许现判一次把它注回去。
    这一条要按「键在不在」判断：空数组的真值是 False，当成缺失就等于用户根本关不掉。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS, "submit_bid_category": _CAT_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)({
        "chapters": {"c1": "<h3>施工组织设计</h3>"},
        "run_input": {"bid_category": []},
    }))
    assert all("submit_bid_category" not in c.tool_names for c in gw.chats), "关掉了就不该再判"
    msg = gw.chats[-1].last_messages[1].content
    assert "必查项】" not in msg, "关掉了就不该注入任何分类知识"
