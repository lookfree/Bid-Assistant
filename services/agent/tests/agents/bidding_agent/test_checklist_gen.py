"""spec333 定制审核表生成：核心生成函数（submit_gateway mock）+ 路由 id 归一化 + 502。"""
import asyncio
import json

import pytest
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.checklist_gen import generate_checklist, _slim_for_checklist

_READ = {
    "project_meta": {"name": "统一身份认证项目", "budget": "600 万", "deadline": "2026-08-01 09:00"},
    "categories": [{"title": "资格要求", "items": [
        {"title": "ISO27001", "value": "须具备且在有效期", "star": True, "source_quote": "见第三章…"},
    ]}],
    "risk_summary": ["未按要求密封即废标"],
    "required_structure": [{"title": "开标一览表", "kind": "form", "required": True, "notes": "正副本各1份"}],
    "scoring": [{"name": "技术方案", "score": 40, "star": True}, {"name": "报价", "score": 30}],
}

_GEN = {"groups": [
    {"title": "资格与资质", "items": ["具备 ISO27001 且在有效期内"]},
    {"title": "唯一性与合规", "items": ["按要求密封，否则废标"]},
]}


def test_generate_checklist_produces_groups(submit_gateway):
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="",
                     gateway=submit_gateway({"submit_checklist": _GEN}))
    result = asyncio.run(generate_checklist(ctx, _READ))
    titles = [g.title for g in result.groups]
    assert titles == ["资格与资质", "唯一性与合规"]
    assert result.groups[0].items == ["具备 ISO27001 且在有效期内"]


def test_generate_checklist_fails_loud_when_model_never_submits(submit_gateway):
    """模型不调 submit_checklist → 抛错（App 层据此回落默认 36），不产假空表。"""
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="",
                     gateway=submit_gateway({}))
    with pytest.raises(RuntimeError, match="submit_checklist"):
        asyncio.run(generate_checklist(ctx, _READ))


def test_generate_checklist_user_msg_carries_requirements(submit_gateway):
    """用户消息带上读标要求：项目名/★项/红线/构成清单都注入，且裁掉 source_quote。"""
    gw = submit_gateway({"submit_checklist": _GEN})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="", gateway=gw)
    asyncio.run(generate_checklist(ctx, _READ))
    user_msg = gw.chats[-1].last_messages[1].content
    assert "统一身份认证项目" in user_msg and "ISO27001" in user_msg
    assert "未按要求密封即废标" in user_msg and "开标一览表" in user_msg
    assert "见第三章" not in user_msg  # source_quote 被裁掉


def test_slim_for_checklist_shape():
    """slim 只出白名单字段：带 required_structure、★评分项名；裁掉 source_quote。"""
    slim = _slim_for_checklist(_READ)
    assert set(slim) == {"project_meta", "categories", "risk_summary",
                         "required_structure", "scoring_star_items"}
    assert slim["scoring_star_items"] == ["技术方案"]  # 只留★项
    assert "source_quote" not in json.dumps(slim, ensure_ascii=False)
    assert slim["required_structure"][0]["title"] == "开标一览表"


def test_slim_for_checklist_tolerates_empty():
    """空/缺字段读标结果不炸（旧结果或独立审查无招标）。"""
    slim = _slim_for_checklist({})
    assert slim["categories"] == [] and slim["risk_summary"] == []


def test_route_normalizes_group_ids(monkeypatch):
    """路由把模型给的组归一化为数字序号 id（不信模型 id；数字与前端默认表 A–H 字母不冲突），返回 {groups}。"""
    from agent.routes import generate as gen_mod
    from agent.agents.bidding_agent.schemas import ChecklistGen

    async def _fake_gen(ctx, read_result):
        return ChecklistGen.model_validate(_GEN)
    monkeypatch.setattr(gen_mod, "generate_checklist", _fake_gen)
    monkeypatch.setattr(gen_mod, "build_gateway", lambda _o: None)
    body = gen_mod.GenerateChecklistBody(read_result=_READ)
    res = asyncio.run(gen_mod.generate_checklist_route(body))
    assert [g["id"] for g in res["groups"]] == ["1", "2"]
    assert res["groups"][0]["title"] == "资格与资质"


def test_route_returns_502_on_generation_failure(monkeypatch):
    """生成抛错（模型未提交/网关炸）→ 502，App 侧回落默认 36。"""
    from agent.routes import generate as gen_mod

    async def _boom(ctx, read_result):
        raise RuntimeError("模型未提交 submit_checklist")
    monkeypatch.setattr(gen_mod, "generate_checklist", _boom)
    monkeypatch.setattr(gen_mod, "build_gateway", lambda _o: None)
    body = gen_mod.GenerateChecklistBody(read_result=_READ)
    res = asyncio.run(gen_mod.generate_checklist_route(body))
    assert res.status_code == 502


def test_group_id_helper_numeric():
    """组 id 归一化为数字序号（与前端默认表 A–H 字母 id 天然不冲突，防状态串档）。"""
    from agent.routes.generate import _group_id
    assert _group_id(0) == "1" and _group_id(9) == "10" and _group_id(25) == "26"
