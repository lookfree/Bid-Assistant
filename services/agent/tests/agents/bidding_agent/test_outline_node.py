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
    assert ids == ["b1", "t1"]   # 代码定序（2026-08-15）：商务组在前，模型给的顺序不作数


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


def test_chapters_are_reordered_group_first_then_structure_order(submit_gateway):
    """2026-08-15 用户实测（849b02b1 轮）：模型把技术偏离表夹进商务表单中间、
    商务条款章掉到全书末尾。顺序是结构性事实，代码定序：商务组连续在前、技术组在后；
    组内按构成清单文档序，无引用的保持模型相对序缀后；重排后重编「第N章」。"""
    args = {"chapters": [
        {"id": "b1", "no": "第一章", "title": "响应函", "group": "business", "sourced": True,
         "structure_ref": "s1", "items": [{"id": "i1", "label": "1 响应函"}]},
        {"id": "t1", "no": "第二章", "title": "技术偏离表", "group": "tech", "sourced": True,
         "items": [{"id": "i2", "label": "1 偏离"}]},
        {"id": "b7", "no": "第三章", "title": "供应商情况一览表", "group": "business", "sourced": True,
         "structure_ref": "s3", "items": [{"id": "i3", "label": "1 一览"}]},
        {"id": "b8", "no": "第四章", "title": "商务条款响应及付款说明", "group": "business", "sourced": False,
         "items": [{"id": "i4", "label": "1 条款"}]},
        {"id": "b2", "no": "第五章", "title": "法定代表人授权书", "group": "business", "sourced": True,
         "structure_ref": "s2", "items": [{"id": "i5", "label": "1 授权"}]},
    ]}
    gw = submit_gateway({"submit_outline": args})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": {"required_structure": [
        {"id": "s1", "title": "响应函", "kind": "form", "required": True},
        {"id": "s2", "title": "法定代表人授权书", "kind": "form", "required": True},
        {"id": "s3", "title": "供应商情况一览表", "kind": "form", "required": True},
    ]}}))
    ids = [c["id"] for c in out["outline"]["chapters"]]
    assert ids == ["b1", "b2", "b7", "b8", "t1"], f"章序没按 商务(构成序+附加)→技术 排: {ids}"
    nos = [c["no"] for c in out["outline"]["chapters"]]
    assert nos == ["第一章", "第二章", "第三章", "第四章", "第五章"], f"重排后没重编章号: {nos}"


def _folded_read() -> dict:
    """含两份表单边界的最小读标结果：1.响应函 / 2.法定代表人授权书。"""
    lines = ["1.响应函", "致：采购人：", "我方承诺响应文件内容完整真实。",
             "编制要求：除允许填写的内容外不得修改本文件。",
             "2.法定代表人授权书", "法定代表人授权书",
             "（供应商全称）法定代表人 授权 （全权代表姓名）为全权代表。"]
    return {"doc_sections": [{"id": f"sec-2-c{i+1}", "text": t} for i, t in enumerate(lines)],
            "doc_headings": []}


_FOLDED_ARGS = {"chapters": [
    {"id": "b1", "no": "第一章", "title": "响应函", "group": "business", "sourced": True,
     "items": [
         {"id": "b1-1", "label": "一、响应函"},
         {"id": "b1-2", "label": "二、法定代表人授权书", "children": [
             {"id": "b1-2-1", "label": "1. 法定代表人授权书正文（按格式填写）"},
             {"id": "b1-2-2", "label": "2. 法定代表人及委托代理人身份证扫描件"}]}]},
    {"id": "t1", "no": "第二章", "title": "技术方案", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 总体"}]},
]}


def test_folded_form_item_is_split_into_its_own_chapter(submit_gateway):
    """2026-08-15 fd5a6ced 实测：模型把「法定代表人授权书」折进响应函章当小节——
    零模型路径按章名只取一份模板，折叠小节菜单有、正文无。招标书里独立存在的表单
    模板必须独立成章：代码硬拆，插在原章之后，重编章号，原章 items 里摘掉该项。"""
    gw = submit_gateway({"submit_outline": _FOLDED_ARGS})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": _folded_read()}))
    chs = out["outline"]["chapters"]
    assert [c["title"] for c in chs] == ["响应函", "法定代表人授权书", "技术方案"]
    assert [c["no"] for c in chs] == ["第一章", "第二章", "第三章"]
    split = chs[1]
    assert split["group"] == "business" and split["id"] not in ("b1", "t1")
    assert [it["label"] for it in split["items"]] == [
        "1. 法定代表人授权书正文（按格式填写）", "2. 法定代表人及委托代理人身份证扫描件"]
    assert all("授权书" not in (it.get("label") or "") for it in chs[0]["items"])


def test_poisoned_cached_outline_is_split_on_hit(submit_gateway, monkeypatch):
    """生产事故形态：折叠提纲已被（旧代码）写进缓存——命中路径同样过拆章，
    同文件再建项目拿到的是矫正后的提纲，不用清缓存。"""
    import hashlib
    import agent.agents.bidding_agent.nodes.outline as om
    monkeypatch.setattr(om, "_read_file_bytes", lambda key: b"TENDER")
    r = _FakeRedis()
    state = {"files": [{"key": "k"}], "read": _folded_read()}
    digest = hashlib.sha256(b"TENDER").hexdigest()[:24]
    r.store[om._cache_key(digest, state)] = json.dumps(
        {"outline": _FOLDED_ARGS, "ref_titles": {}}, ensure_ascii=False)
    gw = submit_gateway({})             # 命中缓存绝不碰模型
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw, redis=r))
    out = asyncio.run(node(state))
    assert [c["title"] for c in out["outline"]["chapters"]] == \
           ["响应函", "法定代表人授权书", "技术方案"]
    assert not gw.chats


def test_split_chapter_maps_ref_by_containment(submit_gateway):
    """评审 F3：构成清单写「附件：法定代表人授权书」——精确比对必落空。标题强匹配
    （互含）也要对上引用，拆出章按构成文档序落位。"""
    gw = submit_gateway({"submit_outline": _FOLDED_ARGS})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    read = _folded_read()
    read["required_structure"] = [
        {"id": "s1", "title": "响应函", "kind": "form", "required": True},
        {"id": "s9", "title": "附件：法定代表人授权书", "kind": "form", "required": True}]
    out = asyncio.run(node({"read": read}))
    split = next(c for c in out["outline"]["chapters"] if c["title"] == "法定代表人授权书")
    assert split.get("structure_ref") == "s9"


def test_split_chapter_without_ref_stays_right_after_parent(submit_gateway):
    """评审 F3 CONFIRMED：拆出章对不上任何构成标题、而父章带引用时，无引用章的默认
    归宿是组尾——授权书漂到商务组最后。after_id 锚：重排后必须紧跟父章。"""
    args = {"chapters": [dict(c) for c in _FOLDED_ARGS["chapters"]]}
    args["chapters"][0] = {**args["chapters"][0], "structure_ref": "s1"}
    args["chapters"].insert(1, {"id": "b2", "no": "第二章", "title": "报价一览表",
                                "group": "business", "sourced": True, "structure_ref": "s2",
                                "items": [{"id": "b2-1", "label": "一、报价一览表"}]})
    gw = submit_gateway({"submit_outline": args})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    read = _folded_read()
    read["required_structure"] = [
        {"id": "s1", "title": "响应函", "kind": "form", "required": True},
        {"id": "s2", "title": "报价一览表", "kind": "form", "required": True}]
    out = asyncio.run(node({"read": read}))
    titles = [c["title"] for c in out["outline"]["chapters"]]
    assert titles == ["响应函", "法定代表人授权书", "报价一览表", "技术方案"], titles
