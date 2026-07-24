import asyncio
import json
import pytest
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import content as content_mod
from agent.agents.bidding_agent.nodes.common import slim_read


class _FakeDeep:
    """桩 deepagent：ainvoke 直接回预置 files（v2 结构，路径带前导斜杠），绕过真实 LLM 规划。"""

    def __init__(self, files):
        self.files = files

    async def ainvoke(self, _input, config=None):
        return {"messages": [], "files": self.files}


def _ctx():
    return RunContext(run_id="r", agent_type="bidding_agent", thread_id="t")


def test_content_node_collects_chapters(monkeypatch):
    files = {"/chapters/t1.html": {"content": "<h3>1.1 需求理解</h3><p>…</p>", "encoding": "utf-8"},
             "/chapters/b1.html": {"content": "<h3>1.1 投标函</h3><p>…</p>"},
             "/todos.txt": {"content": "无关 key，验证前缀过滤"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _FakeDeep(files))
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": {"chapters": [{"id": "t1"}, {"id": "b1"}]}, "read": {}}))
    assert set(out["chapters"]) == {"t1", "b1"}
    assert out["chapters"]["t1"].startswith("<h3>")


def test_content_node_slims_read_input(monkeypatch):
    """read result 现在并入全文分句 doc_sections 与逐条 source_quote（token 大头）——
    喂给 deepagent 规划轮前必须走 slim_read（与 outline/review 同口径），否则整份招标原文顶穿上下文。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    read = {"categories": [{"key": "technical", "title": "技术需求",
                            "items": [{"title": "SLA 要求", "value": "4h 响应",
                                       "source_quote": "原文大段摘录不该进正文提示词"}]}],
            "doc_sections": [{"id": "sec-1-c1", "text": "全文分句更不该进"}],
            "risk_summary": ["r1"]}
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": {"chapters": [{"id": "t1"}]}, "read": read}))
    assert out["chapters"] == {"t1": "<p>…</p>"}
    assert "SLA 要求" in captured["user"]                      # 白名单字段保留
    assert "r1" in captured["user"]
    assert "doc_sections" not in captured["user"]              # 全文分句被裁
    assert "全文分句更不该进" not in captured["user"]
    assert "原文大段摘录不该进正文提示词" not in captured["user"]  # source_quote 被裁


def test_content_node_fails_loud_when_no_chapters(monkeypatch):
    """deepagent 一章都没写 → 抛错（run 落 failed 可重试），不产假空 chapters。"""
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _FakeDeep({}))
    node = content_mod.make_content_node(_ctx())
    with pytest.raises(RuntimeError, match="chapters"):
        asyncio.run(node({"outline": {}, "read": {}}))


class _FakeRagRetrieve:
    """桩 rag_retrieve 模块：content 节点只用得到 rag_enabled + build_reference_block。"""

    def __init__(self, enabled=True, ref="【参考资料·仅供撰写引用】\n- 片段A"):
        self.enabled = enabled
        self.ref = ref
        self.build_calls: list[tuple] = []

    async def rag_enabled(self, user_id, run_input):
        return self.enabled

    async def build_reference_block(self, user_id, queries, top_k, budget=2000, tender_thread_id=None):
        self.build_calls.append((user_id, queries, top_k, tender_thread_id))
        return self.ref


def test_content_node_injects_reference_block_when_rag_enabled(monkeypatch):
    """spec316 A2 架构现实：content 是 deepagent 一次规划+写完所有章，逐章检索不适配——
    改为用 outline 汇成 queries，全局注入一段参考资料进规划 user 消息。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    fake_rag = _FakeRagRetrieve()
    monkeypatch.setattr(content_mod, "rag_retrieve", fake_rag)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", user_id="u1")
    outline = {"chapters": [{"id": "t1", "title": "需求理解", "items": [{"label": "技术方案"}]}]}
    node = content_mod.make_content_node(ctx)
    asyncio.run(node({"outline": outline, "read": {},
                       "run_input": {"rag": {"enabled": True, "top_k": 5}}}))
    user = captured["user"]
    assert "【参考资料·仅供撰写引用】" in user
    # 位置：参考资料段必须在「读标依据」之后、「请逐章生成」指令之前（brief §5）
    assert user.index("读标依据") < user.index("【参考资料·仅供撰写引用】") < user.index("请逐章生成")
    assert fake_rag.build_calls
    user_id, _queries, top_k, tender_thread_id = fake_rag.build_calls[0]
    assert user_id == "u1" and top_k == 5 and tender_thread_id == "t"


class _RaisingRag:
    """gate 抛错的桩：rag_enabled 直接 raise，验证节点不被检索故障阻断。"""

    async def rag_enabled(self, user_id, run_input):
        raise RuntimeError("gate boom")

    async def build_reference_block(self, *a, **kw):
        raise AssertionError("gate 抛错时不该走到 build_reference_block")


def test_content_node_gate_exception_does_not_break_generation(monkeypatch):
    """spec316 A2 harden：rag_enabled 抛错 → 视为 RAG off，正文照常生成、user 消息无 ref。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    monkeypatch.setattr(content_mod, "rag_retrieve", _RaisingRag())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", user_id="u1")
    outline = {"chapters": [{"id": "t1", "title": "需求理解", "items": []}]}
    node = content_mod.make_content_node(ctx)
    out = asyncio.run(node({"outline": outline, "read": {},
                            "run_input": {"rag": {"enabled": True}}}))
    assert out["chapters"] == {"t1": "<p>…</p>"}
    assert "【参考资料·仅供撰写引用】" not in captured["user"]


def test_content_node_deviation_chapter_by_title_injects_guide_and_full_items(monkeypatch):
    """章标题含「偏离」⇒ 用户消息含【偏离表指引】+ technical/commercial/qualification 全量条目（含 star）。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t9.html": {"content": "<table>…</table>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    read = {
        "categories": [
            {"key": "technical", "title": "技术需求", "items": [
                {"title": "SLA 要求", "value": "4h 响应", "clause_ids": ["sec-1-c1"],
                 "star": True, "source_quote": "原文不该进偏离表全量条目块"},
            ]},
            {"key": "commercial", "title": "商务条款", "items": [
                {"title": "质保期", "value": "3 年", "clause_ids": ["sec-2-c1"], "star": False},
            ]},
            {"key": "qualification", "title": "资格要求", "items": [
                {"title": "ISO27001", "value": "须持有", "clause_ids": ["sec-3-c1"], "star": True},
            ]},
            {"key": "overview", "title": "项目概述", "items": [
                {"title": "项目名称", "value": "某系统建设", "clause_ids": []},
            ]},
        ],
    }
    outline = {"chapters": [{"id": "t9", "title": "技术偏离表", "group": "tech"}]}
    node = content_mod.make_content_node(_ctx())
    asyncio.run(node({"outline": outline, "read": read}))
    user = captured["user"]
    assert "【偏离表指引】" in user
    marker = "全量条目（供偏离表逐条落表，不得遗漏 ★/▲）：\n"
    block = user.split(marker, 1)[1].split("\n\n请逐章生成", 1)[0]
    assert "SLA 要求" in block and '"star": true' in block
    assert "质保期" in block and "ISO27001" in block
    assert "项目名称" not in block                     # overview 分类不进偏离全量块
    assert "原文不该进偏离表全量条目块" not in user     # 全量块（及全消息）不含 source_quote
    assert user.index("读标依据") < user.index("【偏离表指引】") < user.index("请逐章生成")


def test_content_node_deviation_chapter_by_structure_ref_triggers(monkeypatch):
    """章标题不含「偏离」，但 structure_ref 指向标题含「偏离」的构成项 ⇒ 同样触发。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/b3.html": {"content": "<table>…</table>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    read = {
        "categories": [{"key": "commercial", "title": "商务条款",
                        "items": [{"title": "付款方式", "value": "验收后付", "star": False}]}],
        "required_structure": [{"id": "s2", "title": "商务偏离表", "kind": "form", "required": True}],
    }
    outline = {"chapters": [{"id": "b3", "title": "响应清单", "group": "business", "structure_ref": "s2"}]}
    node = content_mod.make_content_node(_ctx())
    asyncio.run(node({"outline": outline, "read": read}))
    assert "【偏离表指引】" in captured["user"]
    assert "付款方式" in captured["user"]


def test_content_node_unchanged_when_rag_disabled(monkeypatch):
    """硬不变式：RAG 不生效（无 user_id）→ user 消息与今天逐字节一致；
    用真实（未打桩）rag_retrieve，验证短路路径本身不发起任何网络调用。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    outline = {"chapters": [{"id": "t1", "title": "需求理解", "items": []}]}
    node = content_mod.make_content_node(_ctx())
    asyncio.run(node({"outline": outline, "read": {}}))
    expected = (f"提纲：\n{json.dumps(outline, ensure_ascii=False)}\n\n"
                f"读标依据：\n{json.dumps(slim_read({}), ensure_ascii=False)}\n\n"
                f"请逐章生成正文，每章写入 chapters/<章id>.html。")
    assert captured["user"] == expected


def test_content_node_with_package_injects_scope_constraint(monkeypatch):
    """run_input.package 存在 → 用户消息末尾追加包件范围约束（spec324）。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    outline = {"chapters": [{"id": "t1", "title": "需求理解", "items": []}]}
    node = content_mod.make_content_node(_ctx())
    asyncio.run(node({"outline": outline, "read": {},
                       "run_input": {"package": {"id": "p1", "name": "实网攻防"}}}))
    assert "本项目仅投包件《实网攻防》(p1)" in captured["user"]
    assert "涉及分包件评分表/偏离表仅取该包件" in captured["user"]
    assert captured["user"].endswith("该包件。")


def test_recursion_limit_scales_with_chapter_count(monkeypatch):
    """recursion_limit 随章数动态放大(章多的多包件标固定 100 步会撞 GraphRecursionError):
    2 章 → 下限 100;20 章 → 20*15+60=360;超大 → 封顶 600。"""
    captured = {}

    class _CapDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["limit"] = (config or {}).get("recursion_limit")
            return await super().ainvoke(_input, config)

    def run(n_chapters):
        files = {f"/chapters/c{i}.html": {"content": "<h3>x</h3>"} for i in range(n_chapters)}
        monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapDeep(files))
        chapters = [{"id": f"c{i}", "title": f"章{i}"} for i in range(n_chapters)]
        node = content_mod.make_content_node(_ctx())
        asyncio.run(node({"outline": {"chapters": chapters}, "read": {}}))
        return captured["limit"]

    assert run(2) == 100          # 下限
    assert run(20) == 360         # 20*15+60
    assert run(50) == 600         # 封顶


def test_content_node_form_chapter_injects_tender_template(monkeypatch):
    """招标自带格式章节（structure_ref → kind=form 构成项）：规划轮注入【招标格式模板】+
    该章对应节的原文全文（doc_sections 被 slim_read 裁掉，这里按需回捞格式节）；
    非相关节原文不进上下文。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/b1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    read = {
        "doc_sections": [
            {"id": "sec-40-c1", "text": "响应函（格式）"},
            {"id": "sec-40-c2", "text": "致：（采购人名称）……响应函模板正文段落"},
            {"id": "sec-2-c1", "text": "无关节的招标原文"},
        ],
        "required_structure": [
            {"id": "s9", "title": "响应函", "kind": "form", "clause_ids": ["sec-40-c1"]},
        ],
    }
    outline = {"chapters": [{"id": "b1", "no": "第一章", "title": "响应函（附件1）",
                             "structure_ref": "s9", "items": []}]}
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": outline, "read": read}))
    assert out["chapters"] == {"b1": "<p>…</p>"}
    assert "【招标格式模板】" in captured["user"]
    assert "响应函模板正文段落" in captured["user"]   # 该格式节全文注入（含 clause_ids 未直接引用的 c2）
    assert "无关节的招标原文" not in captured["user"]  # 只取格式章节对应的节


def test_content_node_form_chapter_by_title_keyword_items_clauses(monkeypatch):
    """无 structure_ref 时按章标题关键词（如「报价一览表」）识别，模板定位回退章内 items 的 clause_ids。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/b2.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    read = {"doc_sections": [{"id": "sec-51-c1", "text": "报价一览表（格式）：序号/名称/单价/总价"}],
            "required_structure": []}
    outline = {"chapters": [{"id": "b2", "no": "第二章", "title": "报价一览表",
                             "items": [{"id": "i1", "label": "报价表", "clause_ids": ["sec-51-c1"]}]}]}
    node = content_mod.make_content_node(_ctx())
    asyncio.run(node({"outline": outline, "read": read}))
    assert "【招标格式模板】" in captured["user"]
    assert "序号/名称/单价/总价" in captured["user"]


def test_content_node_no_form_chapter_no_template_block(monkeypatch):
    """无格式类章节（普通技术章）→ 不注入【招标格式模板】，规划消息与今天一致。"""
    captured = {}

    class _CapturingDeep(_FakeDeep):
        async def ainvoke(self, _input, config=None):
            captured["user"] = _input["messages"][0].content
            return await super().ainvoke(_input, config)

    files = {"/chapters/t1.html": {"content": "<p>…</p>"}}
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: _CapturingDeep(files))
    read = {"doc_sections": [{"id": "sec-1-c1", "text": "技术要求原文"}], "required_structure": []}
    outline = {"chapters": [{"id": "t1", "no": "第一章", "title": "实施方案",
                             "items": [{"id": "i1", "label": "方案", "clause_ids": ["sec-1-c1"]}]}]}
    node = content_mod.make_content_node(_ctx())
    asyncio.run(node({"outline": outline, "read": read}))
    assert "【招标格式模板】" not in captured["user"]
    assert "技术要求原文" not in captured["user"]   # 非格式章不回捞原文


def _budgets_from_block(block: str) -> dict:
    import re
    return {m.group(1): int(m.group(2)) for m in re.finditer(r"- (\w+)「[^」]*」目标约 (\d+) 字", block)}


def test_length_plan_block_scoring_weighted():
    """spec330 方案3：按招标评分分值加权——高分方案章拿大头，「投标报价」类评分排除（报价章只拿基线），
    无评分章拿基线。评分点经 chapter_id（或 clause_ids 回退）映射到章。"""
    from agent.agents.bidding_agent.nodes.content import _length_plan_block
    outline = {"chapters": [
        {"id": "t1", "title": "项目理解", "group": "tech", "items": [{"clause_ids": ["c1"]}]},
        {"id": "t2", "title": "技术方案", "group": "tech", "items": [{"clause_ids": ["c2"]}]},
        {"id": "b1", "title": "投标报价", "group": "business", "items": [{"clause_ids": ["c3"]}]},
    ]}
    scoring = [
        {"id": "s1", "category": "技术方案", "name": "方案", "score": 60, "chapter_id": "t2"},
        {"id": "s2", "category": "技术方案", "name": "理解", "score": 10, "clause_ids": ["c1"]},  # 无 chapter_id → clause 回退到 t1
        {"id": "s3", "category": "投标报价", "name": "报价", "score": 30, "chapter_id": "b1"},   # 报价类排除
    ]
    budgets = _budgets_from_block(_length_plan_block({"target_chars": 100000}, outline, scoring))
    assert budgets["t2"] > budgets["t1"] > budgets["b1"]        # 分越高字越多
    assert budgets["b1"] < budgets["t1"]                        # 报价 30 分被排除,没把 b1 抬起来
    assert abs(sum(budgets.values()) - 100000) < 100000 * 0.05  # 总量≈目标


def test_length_plan_block_group_weighted_fallback_no_scoring():
    """无可用评分信号 → 回退组级加权：技术标组 ~80% / 商务标组 ~20%，组内按子项权重分。"""
    from agent.agents.bidding_agent.nodes.content import _length_plan_block, _TECH_SHARE
    outline = {"chapters": [
        {"id": "t1", "title": "项目理解", "group": "tech", "items": [{}, {}, {}]},   # tech 权重 4
        {"id": "t2", "title": "实施方案", "group": "tech", "items": [{}] * 7},        # tech 权重 8
        {"id": "b1", "title": "报价说明", "group": "business", "items": []},          # biz 权重 1
        {"id": "b2", "title": "投标函",   "group": "business", "items": [{}]},        # biz 权重 2
    ]}
    block = _length_plan_block({"target_chars": 130000}, outline)
    assert "全书目标约 130000 字" in block
    budgets = _budgets_from_block(block)
    tech_sum, biz_sum = budgets["t1"] + budgets["t2"], budgets["b1"] + budgets["b2"]
    # 组级：技术标 ~80% / 商务标 ~20%（百字取整有小误差）
    assert abs(tech_sum - 130000 * _TECH_SHARE) < 130000 * 0.03
    assert abs(biz_sum - 130000 * (1 - _TECH_SHARE)) < 130000 * 0.03
    # 商务标整组也拿不到技术标任一大章那么多（防回退到平均摊）
    assert biz_sum < budgets["t2"]
    # 组内仍按子项权重：t2>t1、b2>b1
    assert budgets["t2"] > budgets["t1"] and budgets["b2"] > budgets["b1"]
    assert abs(sum(budgets.values()) - 130000) < 130000 * 0.05
    # 未配置/坏值 → 空串
    assert _length_plan_block({}, outline) == ""
    assert _length_plan_block({"target_chars": 0}, outline) == ""
    assert _length_plan_block({"target_chars": "1万"}, outline) == ""


def test_length_plan_block_single_group_gets_full_budget():
    """只有技术标(或只有商务标)时，该组独占全部预算——独立审查等单组场景不被砍到 80%。"""
    from agent.agents.bidding_agent.nodes.content import _length_plan_block
    outline = {"chapters": [
        {"id": "t1", "title": "方案", "group": "tech", "items": [{}, {}]},
        {"id": "t2", "title": "实施", "group": "tech", "items": [{}] * 5},
    ]}
    budgets = _budgets_from_block(_length_plan_block({"target_chars": 100000}, outline))
    assert abs(sum(budgets.values()) - 100000) < 100000 * 0.05  # 单组独占全部
