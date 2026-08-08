import asyncio
import json
import pytest
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import content as content_mod
from agent.agents.bidding_agent.nodes.common import slim_read


@pytest.fixture(autouse=True)
def _use_deepagent_engine(monkeypatch):
    """本模块测的是 deepagent 旧引擎（引擎开关默认已切到代码编排流水线，任务 #84）。
    旧引擎保留为配置回退，这些测试守住的就是那条回退路——别删，删了回退等于没验证。"""
    from agent.config import settings as _s
    monkeypatch.setattr(_s, "model_content_engine", "deepagent")


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
    # 总量≈工作目标 71400（=100000÷1.4,独立字面量锚定——用实现公式回算会让系数改错也全绿）
    assert abs(sum(budgets.values()) - 71400) < 71400 * 0.05


def test_length_plan_block_group_weighted_fallback_no_scoring():
    """无可用评分信号 → 回退组级加权：技术标组 ~80% / 商务标组 ~20%，组内按子项权重分。"""
    from agent.agents.bidding_agent.nodes.content import _length_plan_block, _TECH_SHARE
    outline = {"chapters": [
        {"id": "t1", "title": "项目理解", "group": "tech", "items": [{}, {}, {}]},   # tech 权重 4
        {"id": "t2", "title": "实施方案", "group": "tech", "items": [{}] * 7},        # tech 权重 8
        {"id": "b1", "title": "报价说明", "group": "business", "items": []},          # biz 权重 1
        {"id": "b2", "title": "投标函",   "group": "business", "items": [{}]},        # biz 权重 2
    ]}
    work = 92900  # =130000÷1.4 百字取整;独立字面量锚定校准方向与幅度
    block = _length_plan_block({"target_chars": 130000}, outline)
    assert f"全书目标约 {work} 字" in block
    budgets = _budgets_from_block(block)
    tech_sum, biz_sum = budgets["t1"] + budgets["t2"], budgets["b1"] + budgets["b2"]
    # 组级：技术标 ~80% / 商务标 ~20%（百字取整有小误差）
    assert abs(tech_sum - work * _TECH_SHARE) < work * 0.03
    assert abs(biz_sum - work * (1 - _TECH_SHARE)) < work * 0.03
    # 商务标整组也拿不到技术标任一大章那么多（防回退到平均摊）
    assert biz_sum < budgets["t2"]
    # 组内仍按子项权重：t2>t1、b2>b1
    assert budgets["t2"] > budgets["t1"] and budgets["b2"] > budgets["b1"]
    assert abs(sum(budgets.values()) - work) < work * 0.05
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
    assert abs(sum(budgets.values()) - 71400) < 71400 * 0.05  # 单组独占全部(校准后口径,字面量锚定)


def test_length_plan_block_calibration_configurable():
    """超写校准系数可经 run_input.overshoot_calibration 运营下发覆盖;非法值回落默认并夹域。"""
    from agent.agents.bidding_agent.nodes.content import _length_plan_block
    outline = {"chapters": [{"id": "t1", "title": "方案", "group": "tech", "items": [{}, {}]}]}
    assert "全书目标约 50000 字" in _length_plan_block(
        {"target_chars": 100000, "overshoot_calibration": 2.0}, outline)
    assert "全书目标约 71400 字" in _length_plan_block(
        {"target_chars": 100000, "overshoot_calibration": "坏值"}, outline)   # 非法 → 默认 1.4
    assert "全书目标约 33300 字" in _length_plan_block(
        {"target_chars": 100000, "overshoot_calibration": 99}, outline)      # 越界 → 夹到 3.0


def test_length_telemetry_recorded(caplog):
    """篇幅遥测（评审 F2 兜底）：产出可见字数 vs 工作/用户目标落 observability 事件
    （生产 root logger=WARNING,logger.info 看不见——遥测必须落库;日志仅本地开发兜底）;
    落库经 to_thread 下线程（log_event 同步 PG 写+advisory 锁,直调会卡事件循环——与 executor/export 同款）;
    口径与前端 countChars 一致（去标签/实体/空白）;未配置目标静默;落库失败不阻断。"""
    from agent.agents.bidding_agent.nodes.content import _log_length_telemetry, _visible_len
    assert _visible_len("<h3>1.1 标题</h3><p>正文&nbsp;两段  x</p>") == len("1.1标题正文两段x")
    chapters = {"t1": "<p>" + "字" * 60000 + "</p>", "b1": "<p>" + "字" * 11400 + "</p>"}

    class _Recorder:
        events = []

        def log_event(self, run_id, agent_type, event_type, **kw):
            self.events.append((run_id, event_type, kw.get("data")))

    ctx = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="t")
    ctx.recorder = _Recorder()
    asyncio.run(_log_length_telemetry(ctx, {"target_chars": 100000}, chapters))
    assert len(ctx.recorder.events) == 1
    run_id, event_type, data = ctx.recorder.events[0]
    # target=100000 work=71400(÷1.4) produced=71400 → produced/work=1.00
    assert (run_id, event_type) == ("r1", "length_telemetry")
    assert data == {"target": 100000, "work": 71400, "produced": 71400,
                    "produced_over_work": 1.0, "produced_over_target": 0.714}
    asyncio.run(_log_length_telemetry(ctx, {}, chapters))  # 未配置目标 → 静默
    assert len(ctx.recorder.events) == 1

    class _Boom:
        def log_event(self, *a, **kw):
            raise RuntimeError("db down")

    ctx.recorder = _Boom()
    with caplog.at_level("WARNING", logger="agent.agents.bidding_agent.nodes.content"):
        asyncio.run(_log_length_telemetry(ctx, {"target_chars": 100000}, chapters))  # 落库炸 → 只 warning,不抛
    assert any("length telemetry event write failed" in r.getMessage() for r in caplog.records)


def test_group_weighted_budgets_count_children():
    """三级提纲预算贯通：children（小节）计入章规模权重——小节多的章拿到更多字数预算。"""
    from agent.agents.bidding_agent.nodes.content import _group_weighted_budgets
    chapters = [
        {"id": "t1", "group": "tech", "items": [
            {"id": "a", "children": [{"id": "a1"}, {"id": "a2"}, {"id": "a3"}]},
            {"id": "b", "children": []},
        ]},  # 计数 2+3=5
        {"id": "t2", "group": "tech", "items": [{"id": "c"}, {"id": "d"}]},  # 计数 2
    ]
    budgets = _group_weighted_budgets(chapters, 90000)
    assert budgets["t1"] > budgets["t2"]  # 含小节的章权重更大
    assert abs(budgets["t1"] / budgets["t2"] - 6 / 3) < 0.35  # 权重比 ≈ (5+1)/(2+1)


def test_iter_items_flattens_children_and_clamps_garbage():
    """三级提纲统一展平口径（评审二轮）：RAG query/模板定位/评分回退/预算计数共用 _iter_items;
    脏 children（数字/字符串/混杂,API 对 items 内部零校验）钳制跳过,绝不炸付费步。"""
    from agent.agents.bidding_agent.nodes.content import _iter_items, _item_count, _outline_queries
    items = [
        {"id": "a", "label": "1.1 总体", "children": [{"id": "a1", "label": "1.1.1 架构", "clause_ids": ["sec-2-c1"]}]},
        {"id": "b", "label": "1.2 实施", "children": 5},          # 垃圾:数字
        {"id": "c", "label": "1.3 保障", "children": ["裸字符串", {"id": "c1", "label": "1.3.1 值守"}]},
        "非字典项",                                                  # 垃圾:裸字符串
    ]
    flat = _iter_items(items)
    assert [it["id"] for it in flat] == ["a", "a1", "b", "c", "c1"]
    assert _item_count(items) == 5
    assert _item_count(None) == 0 and _item_count(5) == 0
    # RAG query 含小节 label（最具体的检索词）
    q = _outline_queries({"chapters": [{"title": "技术方案", "items": items}]})
    assert "1.1.1 架构" in q[0] and "1.3.1 值守" in q[0]


def test_iter_items_recurses_to_the_deepest_outline_level():
    """五级提纲：四、五级子项同样带 clause_ids（模板定位/评分回退要用），只展两层等于把它们丢了；
    规模计数也会少算，反而给拆得最细的章最小的字数预算。自引用脏数据不得把递归拖死。"""
    from agent.agents.bidding_agent.nodes.content import _iter_items, _item_count
    items = [{"id": "l2", "label": "一、总体", "children": [
        {"id": "l3", "label": "1. 架构", "children": [
            {"id": "l4", "label": "（1）人员配置", "clause_ids": ["sec-9-c3"], "children": [
                {"id": "l5", "label": "① 值班安排", "clause_ids": ["sec-9-c4"]},
            ]},
        ]},
    ]}]
    flat = _iter_items(items)
    assert [it["id"] for it in flat] == ["l2", "l3", "l4", "l5"]
    assert [c for it in flat for c in it.get("clause_ids", [])] == ["sec-9-c3", "sec-9-c4"]
    assert _item_count(items) == 4

    loop: dict = {"id": "x", "label": "自引用"}
    loop["children"] = [loop]  # 脏数据（API 对 items 内部零校验）：深度封顶兜住，不递归到栈溢出
    assert len(_iter_items([loop])) <= 10


def test_collect_chapters_drops_phantom_ids():
    """收稿按提纲过滤：实测 "t6-new" 上次没进交付纯属模型后来自己覆盖了它——不过滤等于赌运气。"""
    from agent.agents.bidding_agent.nodes.content import _collect_chapters

    files = {"/chapters/t1.html": {"content": "<p>正文</p>"},
             "/chapters/t6-new.html": {"content": "<p>幽灵</p>"}}
    got = _collect_chapters(files, allowed={"t1", "t6"})
    assert got == {"t1": "<p>正文</p>"}
    # 不传 allowed 保持旧行为（其他调用方不受影响）
    assert set(_collect_chapters(files)) == {"t1", "t6-new"}


def test_heartbeat_label_does_not_pretend_writing_is_sequential():
    """心跳文案：横幅每 5s 动一次——一次长调用 2~8 分钟，定格会被读成"卡住"（实测反馈）。

    但**不能假装是一章接一章写的**：实测正文多路并行（2026-08-08 按调用区间算出并发峰值 7 路、
    54% 的调用互相重叠）。旧文案"第 9/20 章成稿中（本章已 15 分）"两个数都是错的——
    序号其实是"已完成+1"，计时其实是"距上一章写完多久"，用户据此来问"这一章怎么卡了 15 分钟"，
    而那会儿有六七章在同时写、每两三分钟就完成一章。
    """
    from agent.agents.bidding_agent.nodes.content import _heartbeat_label

    label = _heartbeat_label(8, 20, 905, in_flight=6)
    assert "6 章同时撰写中" in label and "15 分 05 秒" in label
    assert "第 9/20 章" not in label, "又把并行写成了串行的章序"
    assert "本章已" not in label, "那个计时不是本章耗时，是距上一章完成的时长"
    # 计数交给前端拼：心跳再带一遍会显示成"已完成 3/20 章，正文·已完成 3/20 章"（用户截图）
    assert "已完成" not in label

    # in_flight 归零 ≠ 没在干活——批间隙要说清"在安排下一批"，不然一句"撰写中"
    # 会被读成"没在并行"（用户看着横幅问了两回）
    gap = _heartbeat_label(8, 20, 65)
    assert "安排下一批" in gap and "1 分 05 秒" in gap and "第 9" not in gap and "已完成" not in gap
    planning = _heartbeat_label(0, 20, 30)
    assert "规划" in planning and "分派" in planning


def test_prompts_carry_length_budget_discipline():
    """字数纪律必须同时写进规划派工与子写手两层（实测：一章写爆 32768 上限被截断，
    返工后 t5/t6/t7 只剩几百字残稿）。规划层丢了预算，子写手那条「若主笔告知」就永远不触发。"""
    from agent.agents.bidding_agent.prompts.content import CONTENT_PLANNER_PROMPT, CHAPTER_WRITER_PROMPT

    assert "每次派工必须写明本章目标字数" in CONTENT_PLANNER_PROMPT
    assert "绝不自造新 id" in CONTENT_PLANNER_PROMPT
    assert "宁短勿爆" in CHAPTER_WRITER_PROMPT


class _DeepThatStopsEarly:
    """桩 deepagent：第一轮只写一部分章，被追问后才补齐剩下的。

    这正是 2026-08-06 的生产实例：20 章的标书写到第 14 章就停了，而当时的收稿逻辑只在
    "一章都没有"时才失败，于是半本标书被当成功交付、照常扣费、照常进入审查与导出。
    """

    def __init__(self, first: dict, second: dict | None = None):
        self.first, self.second = first, second
        self.calls = 0

    async def ainvoke(self, _input, config=None):
        self.calls += 1
        files = self.first if self.calls == 1 else (self.second or {})
        return {"messages": [], "files": files}


def _outline(ids):
    return {"chapters": [{"id": i, "title": f"第{i}章"} for i in ids]}


def test_missing_chapters_are_retried(monkeypatch):
    """漏写的章要补一轮，且只补漏的那几章。"""
    first = {f"/chapters/{i}.html": {"content": f"<p>{i}</p>"} for i in ("t1", "t2")}
    second = {**first, **{f"/chapters/{i}.html": {"content": f"<p>{i}</p>"} for i in ("t3", "t4")}}
    deep = _DeepThatStopsEarly(first, second)
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: deep)
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": _outline(["t1", "t2", "t3", "t4"]), "read": {}}))
    assert set(out["chapters"]) == {"t1", "t2", "t3", "t4"}
    assert deep.calls == 2, "漏了章却没有补写"


def test_no_retry_when_complete(monkeypatch):
    """写全了就不该多跑一轮——补写要花钱花时间。"""
    files = {f"/chapters/{i}.html": {"content": f"<p>{i}</p>"} for i in ("t1", "t2")}
    deep = _DeepThatStopsEarly(files)
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: deep)
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": _outline(["t1", "t2"]), "read": {}}))
    assert set(out["chapters"]) == {"t1", "t2"} and deep.calls == 1


def test_partial_delivery_survives_a_failed_retry(monkeypatch):
    """补写这一轮自己炸了，也不能连累已经写好的章节。

    14 章成稿远比"整步失败、全额退款、从头再跑"对用户有价值。
    """
    first = {"/chapters/t1.html": {"content": "<p>t1</p>"}}

    class _Boom(_DeepThatStopsEarly):
        async def ainvoke(self, _input, config=None):
            self.calls += 1
            if self.calls == 1:
                return {"messages": [], "files": self.first}
            raise RuntimeError("补写轮超时")

    deep = _Boom(first)
    monkeypatch.setattr(content_mod, "create_deep_agent", lambda **kw: deep)
    node = content_mod.make_content_node(_ctx())
    out = asyncio.run(node({"outline": _outline(["t1", "t2"]), "read": {}}))
    assert set(out["chapters"]) == {"t1"}, "补写失败把已成稿的章节也弄丢了"


def test_in_flight_counts_dispatched_writers():
    """并发数必须**从 task 工具的开始/结束按 run_id 配对数出来**。

    写死成 0 或数不上，横幅就退回"撰写中"，用户还是看不出有几路在写——而那正是他
    误以为"卡在某一章"的原因（2026-08-08）。
    """
    import asyncio

    from agent.agents.bidding_agent.nodes.content import ChapterProgressCallback

    cb = ChapterProgressCallback(_ctx(), total=20, titles={"t1": "一"})
    assert cb.in_flight == 0

    async def go():
        for i in range(3):                                        # 派出去 3 路
            await cb.on_tool_start({"name": "task"}, "", inputs={}, run_id=f"r{i}")
        assert cb.in_flight == 3
        await cb.on_tool_end("done", run_id="r0")                 # 收工一路
        assert cb.in_flight == 2
        await cb.on_tool_error(RuntimeError("写挂了"), run_id="r1")  # 挂掉一路也要减
        assert cb.in_flight == 1
        await cb.on_tool_end("done", run_id="r0")                 # 重复结束不重复减
        assert cb.in_flight == 1

    asyncio.run(go())


def test_other_tools_do_not_decrement_in_flight():
    """**这个回调收到的是所有工具的结束事件**：子写手内部的 read_file / write_file 也会来。
    无条件减的话，7 路在写时会被几次 write_file 减到 0，横幅退回含糊的"撰写中"，
    而下一次 task 开始又把计时归零——恰好把要暴露的长停顿藏了起来。"""
    import asyncio

    from agent.agents.bidding_agent.nodes.content import ChapterProgressCallback

    cb = ChapterProgressCallback(_ctx(), total=20, titles={"t1": "一"})

    async def go():
        for i in range(7):
            await cb.on_tool_start({"name": "task"}, "", inputs={}, run_id=f"task-{i}")
        assert cb.in_flight == 7
        for i in range(7):                                        # 子写手内部的工具结束
            await cb.on_tool_end("ok", run_id=f"inner-{i}")
        assert cb.in_flight == 7, "被别的工具的结束事件误减了"

    asyncio.run(go())


def test_write_file_is_not_counted_as_a_dispatch():
    """只有 task 才是"派一路去写"；write_file 是交稿，数进去会让并发数虚高一倍。"""
    import asyncio

    from agent.agents.bidding_agent.nodes.content import ChapterProgressCallback


    cb = ChapterProgressCallback(_ctx(), total=20, titles={"t1": "一"})
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    assert cb.in_flight == 0
    assert cb.done == ["t1"]      # 交稿照常计数
