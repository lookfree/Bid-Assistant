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
    # 规范占位（2026-08-15 拍板续）：表单章小节统一为一条占位，不保留模型写法
    assert [it["label"] for it in split["items"]] == ["一、法定代表人授权书（按招标格式填写）"]
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


def test_split_chapter_with_ref_still_follows_unref_parent(submit_gateway):
    """2026-08-15 生产复现（9016677d）：缓存旧提纲的章全无构成引用，拆出章对上了引用
    （s2/s4）——「有引用排前面」让授权书/报价明细表插队到组首，响应函掉到第三章。
    拆出章的 after_id 锚必须**无条件**优先于引用座次：引用只留给模板投递。"""
    gw = submit_gateway({"submit_outline": _FOLDED_ARGS})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    read = _folded_read()
    read["required_structure"] = [   # 授权书能对上引用；父章响应函没有引用
        {"id": "s2", "title": "法定代表人授权书", "kind": "form", "required": True}]
    out = asyncio.run(node({"read": read}))
    titles = [c["title"] for c in out["outline"]["chapters"]]
    assert titles == ["响应函", "法定代表人授权书", "技术方案"], titles
    split = out["outline"]["chapters"][1]
    assert split.get("structure_ref") == "s2"    # 引用照留，只是不决定座次


def test_parent_items_are_renumbered_after_split(submit_gateway):
    """2026-08-15 用户实测「中间的第二节呢」：折叠表单（二）拆走后，父章剩余小节的中文
    序号必须重编成一、二。父章用材料清单类（资格文件）——纯表单章的小节已统一规范占位，
    重编号只对保留模型小节的章可见。"""
    args = {"chapters": [
        {"id": "b1", "no": "第一章", "title": "资格文件", "group": "business", "sourced": True,
         "items": [
             {"id": "b1-1", "label": "一、营业执照原件扫描件", "children": []},
             {"id": "b1-2", "label": "二、法定代表人授权书", "children": []},
             {"id": "b1-3", "label": "三、财务状况证明材料", "children": []}]},
        dict(_FOLDED_ARGS["chapters"][1]),
    ]}
    gw = submit_gateway({"submit_outline": args})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    read = {"doc_sections": [
        {"id": "sec-2-c1", "text": "1.法定代表人授权书"},
        {"id": "sec-2-c2", "text": "法定代表人授权书"},
        {"id": "sec-2-c3", "text": "（供应商全称）法定代表人 授权 （全权代表姓名）为全权代表。"}],
        "doc_headings": []}
    out = asyncio.run(node({"read": read}))
    parent = next(c for c in out["outline"]["chapters"] if c["title"] == "资格文件")
    assert [it["label"] for it in parent["items"]] == [
        "一、营业执照原件扫描件", "二、财务状况证明材料"]


def test_cache_key_carries_correction_revision():
    """评审 F1 CONFIRMED：8d28e64 曾把「已拆但无 after_id 锚」的提纲写入缓存——矫正
    逻辑对它无从下手（父子关系信息已丢），错序钉满 30 天 TTL。矫正无法逆推旧形状时
    必须升缓存版本换键，让这类条目自然失效重生成。"""
    import agent.agents.bidding_agent.nodes.outline as om
    key = om._cache_key("d" * 24, {})
    assert key.endswith(f":{om._OUTLINE_REV}") and om._OUTLINE_REV >= "r3"


def test_orphan_anchored_chapter_lands_at_its_group_tail():
    """评审 F2：锚章被编辑删除时，商务组的拆出章必须落**本组**末尾——
    落全书末尾等于跟在技术方案后面，文件顺序错乱。"""
    from agent.agents.bidding_agent.nodes.outline import _reorder_chapters
    outline = {"chapters": [
        {"id": "b1", "no": "", "title": "响应函", "group": "business", "items": []},
        {"id": "bx", "no": "", "title": "法定代表人授权书", "group": "business",
         "structure_ref": "s9", "after_id": "gone", "items": []},
        {"id": "t1", "no": "", "title": "技术方案", "group": "tech", "items": []},
    ]}
    out = _reorder_chapters(outline, [])
    assert [c["id"] for c in out["chapters"]] == ["b1", "bx", "t1"]


def test_renumber_tolerates_digit_and_spaced_ordinals():
    """评审 F4：折叠判定容忍「1、」「 二、」等形态，重编号也必须容忍——
    只认裸「N、」会留下断号/重号。各标签保持自己的数字/中文风格。"""
    from agent.agents.bidding_agent.nodes.outline import _renumber_cn_items
    items = [{"label": "1、响应函"}, {"label": " 三、格式说明"}, {"label": "补充说明"}]
    _renumber_cn_items(items)
    assert [it["label"] for it in items] == ["1、响应函", "二、格式说明", "补充说明"]


def _forms_read() -> dict:
    """五份表单+封面格式干扰项的最小读标结果(表单索引来自解析产物,确定性)。"""
    # 各段正文按真实表单体量给（槽位有段内可见字下限——20 字的"表单"在真实标书里
     # 只会是解析碎片，41 份回放据此挡掉「特此证明」这类正文行）
    lines = ["响应文件格式", "封面格式", "（封面按此格式装订）",
             "1.响应函", "致：采购人：",
             "我方承诺响应文件内容完整真实，并接受询价文件的全部条款与条件。",
             "供应商名称：", "日期： 年 月 日",
             "2.法定代表人授权书", "法定代表人授权书",
             "（供应商全称）法定代表人 授权 （全权代表姓名）为全权代表，",
             "全权代表我方处理本次采购活动中的一切事宜，特此授权。",
             "3.报价一览表", "序号\t项目名称\t数量\t单价（元）\t总价（元）\t税率",
             "合计（大写）：", "注：报价含运输、安装、调试与税费等全部费用。",
             "3-1.报价明细表", "报价明细表", "序号\t产品名称\t品牌\t型号\t数量\t单价（元）",
             "注：供应商必须填写分项报价，否则视为无效响应。",
             "4.供应商资格信用承诺函", "供应商资格信用承诺函",
             "我单位郑重承诺守信经营，符合采购文件规定的全部资格条件，",
             "如有不实，自愿接受取消成交资格等处理。", "供应商名称(单位公章)"]
    return {"doc_sections": [{"id": f"sec-2-c{i+1}", "text": t} for i, t in enumerate(lines)],
            "doc_headings": []}


def test_business_form_chapters_are_code_canonical(submit_gateway):
    """2026-08-15 用户拍板：商务标模板章是**复刻**招标书的，不需要模型发挥——章清单/
    章序由代码从全文表单索引直出。模型漏了承诺函、打乱了顺序、授权书用了简称：
    ①漏的补章（用招标原文名）②序按招标文档序③简称归一为招标原文名。技术组不动。"""
    args = {"chapters": [
        {"id": "b1", "no": "第一章", "title": "报价一览表", "group": "business", "sourced": True,
         "items": [{"id": "b1-1", "label": "一、报价一览表"}]},
        {"id": "b2", "no": "第二章", "title": "授权书", "group": "business", "sourced": True,
         "items": [{"id": "b2-1", "label": "一、授权书正文"}]},
        {"id": "b3", "no": "第三章", "title": "响应函", "group": "business", "sourced": True,
         "items": [{"id": "b3-1", "label": "一、响应函"}]},
        {"id": "b4", "no": "第四章", "title": "商务条款偏离表", "group": "business", "sourced": True,
         "items": [{"id": "b4-1", "label": "一、逐条响应"}]},
        {"id": "t1", "no": "第五章", "title": "整体服务方案", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、项目理解"}]},
    ]}
    gw = submit_gateway({"submit_outline": args})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": _forms_read()}))
    titles = [c["title"] for c in out["outline"]["chapters"]]
    assert titles == ["响应函", "法定代表人授权书", "报价一览表", "报价明细表",
                      "供应商资格信用承诺函", "商务条款偏离表", "整体服务方案"], titles
    assert "封面格式" not in titles                       # 封面/封套类不成章
    nos = [c["no"] for c in out["outline"]["chapters"]]
    assert nos == [f"第{n}章" for n in "一二三四五六七"]
    filled = next(c for c in out["outline"]["chapters"] if c["title"] == "报价明细表")
    assert filled["items"], "补出的章要有占位小节"


def test_canonical_pass_is_idempotent_on_cache_hit(submit_gateway, monkeypatch):
    """已定版的提纲缓存命中再过一遍：不重复补章、不重排、逐字一致。"""
    import hashlib
    import agent.agents.bidding_agent.nodes.outline as om
    monkeypatch.setattr(om, "_read_file_bytes", lambda key: b"T")
    r = _FakeRedis()
    state = {"files": [{"key": "k"}], "read": _forms_read()}
    gw1 = submit_gateway({"submit_outline": {"chapters": [
        {"id": "b3", "no": "第一章", "title": "响应函", "group": "business", "sourced": True,
         "items": [{"id": "b3-1", "label": "一、响应函"}]},
        {"id": "t1", "no": "第二章", "title": "整体服务方案", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、项目理解"}]}]}})
    out1 = asyncio.run(make_outline_node(RunContext(
        run_id="r1", agent_type="bidding_agent", thread_id="t1", gateway=gw1, redis=r))(state))
    gw2 = submit_gateway({})
    out2 = asyncio.run(make_outline_node(RunContext(
        run_id="r2", agent_type="bidding_agent", thread_id="t2", gateway=gw2, redis=r))(state))
    assert not gw2.chats
    assert [c["title"] for c in out2["outline"]["chapters"]] == \
           [c["title"] for c in out1["outline"]["chapters"]]
    assert len(out2["outline"]["chapters"]) == len(out1["outline"]["chapters"])


def test_deviation_form_segments_are_never_auto_created(submit_gateway):
    """偏离类表单段(技术偏离表)不补章——偏离表是数据表,章来自模型/构成清单,
    补一个商务组的空壳会和技术组的偏离章打架。"""
    read = _forms_read()
    read["doc_sections"].append({"id": "sec-2-c99", "text": "5.技术偏离表"})
    read["doc_sections"].append({"id": "sec-2-c100", "text": "序号\t需求\t响应\t偏离"})
    gw = submit_gateway({"submit_outline": {"chapters": [
        {"id": "b3", "no": "第一章", "title": "响应函", "group": "business", "sourced": True,
         "items": [{"id": "b3-1", "label": "一、响应函"}]},
        {"id": "t1", "no": "第二章", "title": "技术需求/服务偏离表", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、逐条响应"}]}]}})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": read}))
    biz = [c["title"] for c in out["outline"]["chapters"] if c["group"] == "business"]
    assert "技术偏离表" not in biz


def test_form_chapter_items_are_canonical_placeholders(submit_gateway):
    """2026-08-15 用户拍板续：表单章小节也统一成规范占位——模型这次写「身份证明」下次
    写「授权书正文」，菜单每轮一副面孔。规范占位一条；原小节的 clause_ids **汇总保留**
    （定位原文跳转与模板定位 clause 捷径不能丢）。"""
    args = {"chapters": [
        {"id": "b1", "no": "第一章", "title": "响应函", "group": "business", "sourced": True,
         "items": [
             {"id": "b1-1", "label": "一、响应函正文", "clause_ids": ["sec-1-c20"]},
             {"id": "b1-2", "label": "二、签章及日期", "clause_ids": ["sec-1-c22"],
              "children": [{"id": "b1-2-1", "label": "1. 盖章", "clause_ids": ["sec-1-c56"]}]}]},
        {"id": "t1", "no": "第二章", "title": "整体服务方案", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、项目理解"}, {"id": "t1-2", "label": "二、技术方案"}]},
    ]}
    gw = submit_gateway({"submit_outline": args})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": _forms_read()}))
    b1 = next(c for c in out["outline"]["chapters"] if c["title"] == "响应函")
    assert [it["label"] for it in b1["items"]] == ["一、响应函（按招标格式填写）"]
    assert b1["items"][0]["clause_ids"] == ["sec-1-c20", "sec-1-c22", "sec-1-c56"]
    t1 = next(c for c in out["outline"]["chapters"] if c["title"] == "整体服务方案")
    assert [it["label"] for it in t1["items"]] == ["一、项目理解", "二、技术方案"], "技术章小节不动"


def test_material_list_form_chapters_keep_model_items(submit_gateway):
    """材料清单类章（资格文件/证明材料）的小节是证照就位与正文写作的骨架——不抹。"""
    read = _forms_read()
    read["doc_sections"] += [{"id": "sec-3-c1", "text": "5.资格文件"},
                             {"id": "sec-3-c2", "text": "以下资格证明文件均为原件扫描件。"}]
    args = {"chapters": [
        {"id": "b1", "no": "第一章", "title": "资格文件", "group": "business", "sourced": True,
         "items": [{"id": "b1-1", "label": "一、营业执照原件扫描件"},
                   {"id": "b1-2", "label": "二、财务状况证明材料"}]},
        {"id": "t1", "no": "第二章", "title": "整体服务方案", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、项目理解"}]},
    ]}
    gw = submit_gateway({"submit_outline": args})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": read}))
    b1 = next(c for c in out["outline"]["chapters"] if "资格文件" in c["title"])
    assert [it["label"] for it in b1["items"]] == ["一、营业执照原件扫描件", "二、财务状况证明材料"]


def test_duplicate_slot_names_do_not_create_duplicate_chapters(submit_gateway):
    """评审 B：须知里的构成清单（（一）响应函…）与格式章的真表单同名——槽位不按名去重
    的话，第二个同名槽位没人认领，补章造出两个「响应函」章，且随缓存钉死。"""
    read = _forms_read()
    read["doc_sections"] = ([{"id": "sec-0-c1", "text": "（一）响应函"},
                             {"id": "sec-0-c2", "text": "以上为响应文件构成清单，供应商须按顺序装订"},
                             {"id": "sec-0-c3", "text": "并逐页加盖单位公章，缺项按无效响应处理。"}]
                            + read["doc_sections"])
    gw = submit_gateway({"submit_outline": {"chapters": [
        {"id": "b3", "no": "第一章", "title": "响应函", "group": "business", "sourced": True,
         "items": [{"id": "b3-1", "label": "一、响应函"}]},
        {"id": "t1", "no": "第二章", "title": "整体服务方案", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、项目理解"}]}]}})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": read}))
    titles = [c["title"] for c in out["outline"]["chapters"]]
    assert titles.count("响应函") == 1, titles


def test_exact_claim_beats_containment_claim(submit_gateway):
    """评审 C：贪心首中会让「响应函格式符合性说明」章先把「响应函」槽位抢走并被改名——
    精确匹配必须先于互含匹配认领。"""
    gw = submit_gateway({"submit_outline": {"chapters": [
        {"id": "b9", "no": "第一章", "title": "响应函格式符合性说明", "group": "business",
         "sourced": True, "items": [{"id": "b9-1", "label": "一、说明"}]},
        {"id": "b3", "no": "第二章", "title": "响应函", "group": "business", "sourced": True,
         "items": [{"id": "b3-1", "label": "一、响应函"}]},
        {"id": "t1", "no": "第三章", "title": "整体服务方案", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、项目理解"}]}]}})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": _forms_read()}))
    titles = [c["title"] for c in out["outline"]["chapters"]]
    assert titles.count("响应函") == 1, titles
    assert "响应函格式符合性说明" in titles, "说明章被抢改名"
    exact = next(c for c in out["outline"]["chapters"] if c["title"] == "响应函")
    assert exact["id"] == "b3", "槽位被互含章抢走"


def test_composite_guard_covers_all_connectors(submit_gateway):
    """评审 D：复合名守卫只认[及和]，「与」连接的复合槽位（法定代表人证明与授权书这类）
    仍会把「承诺函」章改成复合名并抹小节——连接词集合必须与匹配器同一份[与及和、/]。"""
    read = {"doc_sections": [
        {"id": "sec-2-c1", "text": "1.资格声明与承诺函"},
        {"id": "sec-2-c2", "text": "我单位郑重声明并承诺守信经营，符合采购文件规定的全部资格条件，"},
        {"id": "sec-2-c3", "text": "如有不实自愿接受取消成交资格等处理。"},
        {"id": "sec-2-c4", "text": "供应商名称(单位公章)"}], "doc_headings": []}
    gw = submit_gateway({"submit_outline": {"chapters": [
        {"id": "b5", "no": "第一章", "title": "承诺函", "group": "business", "sourced": True,
         "items": [{"id": "b5-1", "label": "一、承诺正文"}, {"id": "b5-2", "label": "二、签章"}]},
        {"id": "t1", "no": "第二章", "title": "整体服务方案", "group": "tech", "sourced": True,
         "items": [{"id": "t1-1", "label": "一、项目理解"}]}]}})
    node = make_outline_node(RunContext(run_id="r", agent_type="bidding_agent",
                                        thread_id="t", gateway=gw))
    out = asyncio.run(node({"read": read}))
    b5 = next(c for c in out["outline"]["chapters"] if c["id"] == "b5")
    assert b5["title"] == "承诺函", "复合名槽位不许改章名"
    assert [it["label"] for it in b5["items"]] == ["一、承诺正文", "二、签章"], "复合名槽位不许抹小节"


def test_slot_gate_rejects_the_noise_41_tenders_exposed():
    """2026-08-16 拿库里 **41 份真实招标书** 回放代码定版：槽位表里混进章标题、正文长句、
    要求条款、带★编号的脏名——补章会给这些标书凭空造出垃圾章（我引入的线上回归）。
    每条拒绝规则都对应回放里出现过的真实脏数据。"""
    from agent.agents.bidding_agent.nodes.outline import _is_form_slot, _slot_name
    body = "我方郑重承诺遵守采购文件全部条款，并对所提交材料的真实性负责，如有不实自愿接受处理。"
    # 拒：章/部分级标题、正文长句、要求条款、落款行、解析碎片、版式类
    for bad in ["第三章 报价文件内容及格式", "第六部分  格式附件", "第四章 响应文件相关格式",
                "9.3 响应文件中报价一览表内容与响应文件中明细表内容不一致的，以",
                "（3）符合《政府采购法》第22 条规定的承诺书；（格式后附）",
                "2资质类证书或授权书要求", "特此证明", "证证明",
                "提交书面异议材料格式", "资格审查资料内容及格式"]:
        assert not _is_form_slot(bad, body), f"垃圾槽位没挡住: {bad}"
    # 收：真表单（脏前缀要剥干净）
    for raw, want in [("1★保密承诺书", "保密承诺书"), ("保 密承诺书", "保密承诺书"),
                      ("附件1-1 报价一览表", "报价一览表"), ("附资信证明", "资信证明"),
                      ("附件五 乙方经办人授权书", "乙方经办人授权书"),
                      ("响应函", "响应函"), ("10单位负责人信息一览表", "单位负责人信息一览表")]:
        assert _is_form_slot(raw, body), f"真表单被误拒: {raw}"
        assert _slot_name(raw) == want, f"名字没洗干净: {raw} → {_slot_name(raw)}"
    # 同一份表单的两种脏写法归一后必须撞成一个槽位（否则补两次章）
    assert _slot_name("1★保密承诺书") == _slot_name("保 密承诺书")
    # 段内几乎没内容的（解析碎片）一律拒
    assert not _is_form_slot("承诺书", "略")


def test_slot_gate_does_not_maim_real_names_or_drop_real_forms():
    """评审 2026-08-16 实跑复现两条误伤：
    ①「附」被无差别当前缀剥 → 附加服务承诺书 变「加服务承诺书」，残名直接印进标书；
    ②三字名只放行「XX函」→ 承诺书/授权书/声明书 这些**整词表单**被拒，招标要求的表单
      既不补章、已有章也拿不到 form_order。"""
    from agent.agents.bidding_agent.nodes.outline import _is_form_slot, _slot_name
    body = "我单位郑重承诺遵守采购文件全部条款，所提交材料真实有效，如有不实自愿承担法律责任。"
    assert _slot_name("附加服务承诺书") == "附加服务承诺书", "词首的「附加」被当成前缀剥了"
    assert _is_form_slot("附加服务承诺书", body)
    assert _slot_name("附资信证明") == "资信证明" and _slot_name("附：资信证明") == "资信证明"
    for ok in ("承诺书", "授权书", "声明书", "一览表", "响应函", "澄清函"):
        assert _is_form_slot(ok, body), f"三字真表单被拒: {ok}"
    assert not _is_form_slot("证证明", body), "只靠证明后缀蒙混的碎片仍要拒"
