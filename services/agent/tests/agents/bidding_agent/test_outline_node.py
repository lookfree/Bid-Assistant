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


class _FakeRedis:
    def __init__(self):
        self.store = {}

    def get(self, k):
        return self.store.get(k)

    def set(self, k, v, ex=None):
        self.store[k] = v

    def xadd(self, *a, **k):
        pass


_OUTLINE_ARGS_REF = {"chapters": [
    {"id": "t1", "no": "第一章", "title": "技术方案", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 总体"}]},
    {"id": "b1", "no": "第二章", "title": "投标报价一览表", "group": "business", "sourced": True,
     "structure_ref": "s-old", "items": [{"id": "b1-1", "label": "1.1 报价"}]},
]}


def test_same_tender_file_reuses_the_cached_outline(submit_gateway, monkeypatch):
    """2026-08-14 用户实测：同一份招标书多跑几次，提纲 12↔15 章漂移。同文件字节哈希
    命中缓存：第二次**零模型调用**、章数/标题逐字同第一次；structure_ref 按标题重映射
    到本轮读标的构成项 id（构成项 id 由读标模型自拟，跨轮不稳）。"""
    import agent.agents.bidding_agent.nodes.outline as om
    monkeypatch.setattr(om, "_read_file_bytes", lambda key: b"TENDER")
    r = _FakeRedis()
    gw1 = submit_gateway({"submit_outline": _OUTLINE_ARGS_REF})
    node1 = make_outline_node(RunContext(run_id="r1", agent_type="bidding_agent",
                                         thread_id="t1", gateway=gw1, redis=r))
    st1 = {"files": [{"key": "u1/tender.docx"}],
           "read": {"required_structure": [
               {"id": "s-old", "title": "投标报价一览表", "kind": "form", "required": True}]}}
    out1 = asyncio.run(node1(st1))
    gw2 = submit_gateway({})            # 命中缓存就绝不会碰模型；碰了必然拿不到提交而炸
    node2 = make_outline_node(RunContext(run_id="r2", agent_type="bidding_agent",
                                         thread_id="t2", gateway=gw2, redis=r))
    st2 = {"files": [{"key": "u2/另一次上传.docx"}],       # 不同上传 key，同字节
           "read": {"required_structure": [
               {"id": "s-new", "title": "投标报价一览表", "kind": "form", "required": True}]}}
    out2 = asyncio.run(node2(st2))
    assert [c["title"] for c in out2["outline"]["chapters"]] == \
           [c["title"] for c in out1["outline"]["chapters"]], "同文件提纲不一致"
    refs = [c.get("structure_ref") for c in out2["outline"]["chapters"]]
    assert "s-new" in refs and "s-old" not in refs, "构成项引用没重映射到本轮读标"
    assert not gw2.chats, "命中缓存还调了模型"


def test_changed_tender_bytes_regenerate(submit_gateway, monkeypatch):
    """文件字节变了（哪怕上传 key 相同）→ 缓存失效照常生成，不吃旧提纲。"""
    import agent.agents.bidding_agent.nodes.outline as om
    r = _FakeRedis()
    monkeypatch.setattr(om, "_read_file_bytes", lambda key: b"V1")
    gw1 = submit_gateway({"submit_outline": _OUTLINE_ARGS_REF})
    asyncio.run(make_outline_node(RunContext(run_id="r1", agent_type="bidding_agent",
                                             thread_id="t1", gateway=gw1, redis=r))(
        {"files": [{"key": "k"}], "read": {}}))
    monkeypatch.setattr(om, "_read_file_bytes", lambda key: b"V2")
    gw2 = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    asyncio.run(make_outline_node(RunContext(run_id="r2", agent_type="bidding_agent",
                                             thread_id="t2", gateway=gw2, redis=r))(
        {"files": [{"key": "k"}], "read": {}}))
    assert gw2.chats, "字节变了还吃旧缓存"


def test_outline_call_pins_temperature_zero(submit_gateway):
    """提纲步采样收敛：temperature=0 随 get_chat 下发——缓存未命中时的首跑也要稳。"""
    gw = submit_gateway({"submit_outline": _OUTLINE_ARGS})
    asyncio.run(make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                             thread_id="t", gateway=gw))({"read": {}}))
    assert gw.get_chat_kwargs and gw.get_chat_kwargs[-1].get("temperature") == 0.0
