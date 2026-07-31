"""分类知识的五个注入点（spec334 Task B）。

用测试夹具塞假知识，不依赖 spec335 的真内容——管线的正确性与知识的正确性要能分开验收。
"""
import asyncio

import pytest

from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.prompts import categories as cat_mod
from agent.agents.bidding_agent.nodes.outline import make_outline_node
from agent.agents.bidding_agent.nodes.review import make_review_node
from agent.agents.bidding_agent.nodes.content import make_content_node
from agent.agents.bidding_agent.checklist_gen import generate_checklist

_OUTLINE_ARGS = {"chapters": [{"id": "t1", "no": "第一章", "title": "整体方案", "group": "tech",
                               "sourced": True, "items": []}]}
_RISK_ARGS = {"score": 80, "items": [], "passed_items": []}
_CHECKLIST_ARGS = {"groups": [{"title": "资格与资质", "items": ["营业执照在有效期内"]}]}

_FAKE_KNOWLEDGE = [
    {"category": "goods", "purpose": "chapters", "status": "verified", "text": "报价明细表须含产地与品牌两列"},
    {"category": "goods", "purpose": "planning", "status": "unverified", "text": "技术参数逐条响应"},
    {"category": "goods", "purpose": "writing", "status": "verified", "text": "偏离表逐条对照不得概括"},
    {"category": "goods", "purpose": "review", "status": "verified", "text": "声明函须填列所有制造商"},
    {"category": "goods", "purpose": "checklist", "status": "verified", "text": "质保期不低于招标要求"},
    {"category": "services", "purpose": "chapters", "status": "verified", "text": "违约责任承诺单独成节"},
    {"category": "services", "purpose": "review", "status": "verified", "text": "人员配置覆盖全部岗位"},
]
_FAKE_PATCHES = [{"keywords": ["劳务派遣"], "item": "须提供劳务派遣经营许可证", "level": "高", "status": "unverified"}]


@pytest.fixture
def knowledge(monkeypatch):
    monkeypatch.setattr(cat_mod, "CATEGORY_KNOWLEDGE", _FAKE_KNOWLEDGE)
    monkeypatch.setattr(cat_mod, "INDUSTRY_PATCHES", _FAKE_PATCHES)


def _ctx(submit_gateway, args):
    return RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=submit_gateway(args))


def test_empty_knowledge_changes_nothing(monkeypatch, submit_gateway):
    """知识表为空 ⇒ 注入为空串 ⇒ 各处消息与启用分类前逐字节一致。
    这条保证管线与知识可以分开上线、分开验收：清空知识表，全链路必须退回改动前的样子。"""
    monkeypatch.setattr(cat_mod, "CATEGORY_KNOWLEDGE", [])
    monkeypatch.setattr(cat_mod, "INDUSTRY_PATCHES", [])
    gw = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_outline_node(ctx)({"read": {"categories": []}, "run_input": {"bid_category": ["goods"]}}))
    with_cat = gw.chats[-1].last_messages[1].content

    gw2 = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    ctx2 = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw2)
    asyncio.run(make_outline_node(ctx2)({"read": {"categories": []}}))
    assert with_cat == gw2.chats[-1].last_messages[1].content


def test_outline_takes_the_primary_category_only(knowledge, submit_gateway):
    """提纲只取主类别：提纲结构只能有一套，两套必备章节会膨胀出重复骨架。"""
    gw = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_outline_node(ctx)({"read": {"categories": []},
                                        "run_input": {"bid_category": ["goods", "services"]}}))
    msg = gw.chats[-1].last_messages[1].content
    assert "报价明细表须含产地与品牌两列" in msg
    assert "违约责任承诺单独成节" not in msg, "次类别的必备章节不该进提纲"
    assert "以清单为准" in msg, "必须带上「招标文件构成清单优先」的口径"


def test_review_takes_both_categories_and_industry_patches(knowledge, submit_gateway):
    """审查主次都取——查多了只多看一眼，漏一条是废标；并且必须标明「经验≠明文要求」。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)({
        "read": {"risk_summary": [], "bid_category": {"value": ["goods", "services"]},
                 "categories": [{"key": "qualification", "title": "资格",
                                 "items": [{"title": "劳务派遣资质", "value": "须具备"}]}]},
        "chapters": {"c1": "<p>正文</p>"},
    }))
    msg = gw.chats[-1].last_messages[1].content
    assert "声明函须填列所有制造商" in msg and "人员配置覆盖全部岗位" in msg
    assert "不是本次招标的明文要求" in msg
    assert "须提供劳务派遣经营许可证" in msg, "命中行业关键词应追加资质必查项"


def test_industry_patch_not_injected_when_no_keyword_hit(knowledge, submit_gateway):
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)({
        "read": {"risk_summary": [], "bid_category": {"value": ["goods"]}, "categories": []},
        "chapters": {"c1": "<p>正文</p>"},
    }))
    assert "劳务派遣经营许可证" not in gw.chats[-1].last_messages[1].content


def test_writing_points_reach_the_chapter_writer_prompt(knowledge, submit_gateway):
    """**落笔要点必须进子写手的 system_prompt**，不能只加在规划轮的用户消息里——
    真正落笔的是子写手，靠规划轮转述等于把要点押在模型愿不愿复述上（提纲 desc 就是这么丢过的）。"""
    seen: dict = {}

    def fake_create_deep_agent(**kw):
        seen.update(kw)
        raise RuntimeError("stop-here")   # 只验证构造参数，不跑整个 deepagent

    import agent.agents.bidding_agent.nodes.content as content_mod
    orig = content_mod.create_deep_agent
    content_mod.create_deep_agent = fake_create_deep_agent
    try:
        ctx = _ctx(submit_gateway, {})
        with pytest.raises(RuntimeError):
            asyncio.run(make_content_node(ctx)({"outline": {}, "read": {},
                                                "run_input": {"bid_category": ["goods"]}}))
    finally:
        content_mod.create_deep_agent = orig
    writer_prompt = seen["subagents"][0]["system_prompt"]
    assert "偏离表逐条对照不得概括" in writer_prompt
    assert "报价明细表须含产地与品牌两列" not in writer_prompt, "章节层面的要点不该塞给子写手"


def test_checklist_prefers_the_body_value_over_the_detected_one(knowledge, submit_gateway):
    """审核表是同步接口没有 run_input：App 下发的有效值优先，缺省才回落 read_result 里的判定值。
    只靠回落的话，用户改判对审核表不生效。"""
    read_result = {"categories": [], "bid_category": {"value": ["services"]}}

    gw = submit_gateway({"submit_checklist": _CHECKLIST_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(generate_checklist(ctx, read_result, ["goods"]))
    assert "质保期不低于招标要求" in gw.chats[-1].last_messages[1].content  # 用了 body 的 goods

    gw2 = submit_gateway({"submit_checklist": _CHECKLIST_ARGS})
    ctx2 = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw2)
    asyncio.run(generate_checklist(ctx2, read_result))
    assert "质保期不低于招标要求" not in gw2.chats[-1].last_messages[1].content  # 回落 services，无该条


def test_unverified_entries_are_phrased_as_a_prompt_not_a_requirement(knowledge):
    """未经核实的条目不得以「必须」的口吻出现——写手对「必须」是无条件服从的，
    一条错的必备章节会让每本标书都多出一章不该有的内容，而用户看不出那是我们编的。"""
    verified = cat_mod.category_scope(["goods"], "chapters")
    unverified = cat_mod.category_scope(["goods"], "planning")
    assert "必须：报价明细表须含产地与品牌两列" in verified
    assert "通常：技术参数逐条响应" in unverified and "请核对" in unverified


def test_shipped_knowledge_is_well_formed():
    """随包发出的知识表逐条自检：类别/用途/状态必须是合法值。
    33 条手写条目里拼错一个 purpose，那条就永远不会被注入——而且**静默**，没有任何报错。"""
    for e in cat_mod.CATEGORY_KNOWLEDGE:
        assert e["category"] in cat_mod.CATEGORY_LABEL, e
        assert e["purpose"] in cat_mod.PURPOSE_TITLE, e
        assert e["status"] in ("verified", "unverified"), e
        assert e["text"].strip(), e
    for p in cat_mod.INDUSTRY_PATCHES:
        assert p["keywords"] and p["item"].strip(), p
        assert p["level"] in ("高", "中"), p


def test_no_repealed_qualification_in_the_patch_table():
    """已废止的资质不得在表里：物业服务企业资质 2018 年随《物业管理条例》修订删除。
    留着的后果是审查报告报一条假风险，用户信了会去补一个根本不存在的证。"""
    joined = " ".join(p["item"] for p in cat_mod.INDUSTRY_PATCHES)
    assert "物业服务企业资质" not in joined


def test_every_shipped_entry_is_still_phrased_as_a_prompt():
    """随包发出的条目目前全是待验证——**一条都不许以「必须」的口吻出现**。
    等某条真核到了现行法规原文或我们自己的真实标书，再把它的 status 改成 verified。"""
    assert all(e["status"] == "unverified" for e in cat_mod.CATEGORY_KNOWLEDGE)
    for purpose in cat_mod.PURPOSE_TITLE:
        for cat in cat_mod.CATEGORY_LABEL:
            block = cat_mod.category_scope([cat], purpose)
            assert "必须：" not in block, (cat, purpose)


def test_self_check_matches_industry_patches_against_the_uploaded_bid(knowledge, submit_gateway):
    """自查项目（没有招标文件）的资质补丁必须拿**上传标书正文**匹配。
    这条卡的是一个静默失效：slim_read({}) 回的是非空 dict，`payload["read"] or chapters`
    永远取不到 chapters，补丁对整类项目一条都不会命中，而且没有任何报错。"""
    gw = submit_gateway({"submit_risk_report": _RISK_ARGS, "submit_bid_category": {"value": ["services"]}})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    asyncio.run(make_review_node(ctx)({
        "chapters": {"c1": "<h3>人员配置</h3><p>本项目采用劳务派遣用工方式</p>"},
    }))
    review_msg = next(c.last_messages[1].content for c in gw.chats
                      if "submit_risk_report" in c.tool_names)
    assert "须提供劳务派遣经营许可证" in review_msg
