import asyncio
import json
import pytest
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.outline import make_outline_node
from agent.agents.bidding_agent.nodes.common import slim_read


_OUTLINE_ARGS = {"chapters": [
    {"id": "t1", "no": "第一章", "title": "项目理解与整体方案", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 需求理解"}]},
    {"id": "b1", "no": "第一章", "title": "投标函", "group": "business", "sourced": True,
     "items": [{"id": "b1-1", "label": "1.1 投标函"}]},
]}


def test_outline_node_reads_read_produces_outline(submit_gateway):
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_outline": _OUTLINE_ARGS}))
    node = make_outline_node(ctx)
    out = asyncio.run(node({"read": {"risk_summary": ["缺 ISO27001"]}}))
    ids = [c["id"] for c in out["outline"]["chapters"]]
    assert ids == ["t1", "b1"]


def test_outline_node_fails_loud_when_model_never_submits(submit_gateway):
    """模型不调用 submit_outline → 节点抛错（run 落 failed 可重试），不产假空提纲。"""
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({}))
    node = make_outline_node(ctx)
    with pytest.raises(RuntimeError, match="submit_outline"):
        asyncio.run(node({"read": {}}))


_REQUIRED_STRUCTURE = [
    {"id": "s1", "title": "技术标（分册）", "kind": "volume", "required": True},
    {"id": "s2", "title": "投标报价一览表", "kind": "form", "required": True},
    {"id": "s3", "title": "密封与签章", "kind": "rule", "required": True, "notes": "正副本各1/4份"},
]


def test_outline_node_without_required_structure_user_msg_unchanged(submit_gateway):
    """read.required_structure 为空/缺失 → 用户消息与今天字节级一致（向后兼容，spec321）。"""
    gw = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_outline_node(ctx)
    asyncio.run(node({"read": {"risk_summary": ["缺 ISO27001"]}}))
    user_msg = gw.chats[-1].last_messages[1].content
    read = json.dumps(slim_read({"risk_summary": ["缺 ISO27001"]}), ensure_ascii=False)
    assert user_msg == f"读标结论：\n{read}\n请据此产出提纲。"


def test_outline_node_with_required_structure_injects_skeleton(submit_gateway):
    """read.required_structure 非空 → 用户消息追加骨架，且每个构成项 id 都出现在消息里。"""
    gw = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_outline_node(ctx)
    asyncio.run(node({"read": {"risk_summary": [], "required_structure": _REQUIRED_STRUCTURE}}))
    user_msg = gw.chats[-1].last_messages[1].content
    assert "投标文件构成清单" in user_msg
    for item in _REQUIRED_STRUCTURE:
        assert item["id"] in user_msg and item["title"] in user_msg


def test_outline_node_without_package_user_msg_unchanged(submit_gateway):
    """run_input 无 package（未选包/单包）→ 用户消息与今天字节级一致（spec324 向后兼容）。"""
    gw = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_outline_node(ctx)
    asyncio.run(node({"read": {"risk_summary": ["缺 ISO27001"]}, "run_input": {}}))
    user_msg = gw.chats[-1].last_messages[1].content
    read = json.dumps(slim_read({"risk_summary": ["缺 ISO27001"]}), ensure_ascii=False)
    assert user_msg == f"读标结论：\n{read}\n请据此产出提纲。"


def test_outline_node_with_package_injects_scope_constraint(submit_gateway):
    """run_input.package 存在 → 用户消息追加包件范围约束，含包名与 id。"""
    gw = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
    node = make_outline_node(ctx)
    asyncio.run(node({"read": {"risk_summary": []},
                       "run_input": {"package": {"id": "p1", "name": "实网攻防"}}}))
    user_msg = gw.chats[-1].last_messages[1].content
    assert "本项目仅投包件《实网攻防》(p1)" in user_msg
    assert "其它包件内容一律忽略" in user_msg
