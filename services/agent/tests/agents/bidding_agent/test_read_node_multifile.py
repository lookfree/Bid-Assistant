import asyncio
from agent.runtime.registry import RunContext
from agent.parsing.types import ParsedDoc
from agent.agents.bidding_agent.nodes import read as read_mod

_READ_ARGS = {
    "categories": [{"key": "qualification", "title": "资格要求",
                    "items": [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
    "risk_summary": ["缺 ISO27001 即废标"],
}

_DOC1 = ParsedDoc(text="公告全文", kind="docx",
                  clauses=[{"id": "sec-1-c1", "text": "项目名称：某某平台建设"},
                           {"id": "sec-2-c1", "text": "投标截止时间"}])
_DOC2 = ParsedDoc(text="技术规范全文", kind="pdf",
                  clauses=[{"id": "sec-1-c1", "text": "★须具备 ISO27001 认证"}])


def test_read_node_merges_multiple_files(monkeypatch, submit_gateway):
    """多文件：逐个 read_and_parse → merge_parsed 合并，read 结果加 doc_files（章节区间）。"""
    by_key = {"a/gonggao.docx": _DOC1, "b/jishu.pdf": _DOC2}
    monkeypatch.setattr(read_mod, "read_and_parse", lambda key: by_key[key])
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))
    state = {"file_key": "a/gonggao.docx",
             "files": [{"key": "a/gonggao.docx", "name": "采购公告.docx"},
                       {"key": "b/jishu.pdf", "name": "技术规范书.pdf"}]}
    out = asyncio.run(read_mod.make_read_node(ctx)(state))
    assert out["read"]["doc_files"] == [
        {"name": "采购公告.docx", "sec_from": 1, "sec_to": 2},
        {"name": "技术规范书.pdf", "sec_from": 3, "sec_to": 3},
    ]
    assert out["read"]["doc_sections"] == [
        {"id": "sec-1-c1", "text": "项目名称：某某平台建设"},
        {"id": "sec-2-c1", "text": "投标截止时间"},
        {"id": "sec-3-c1", "text": "★须具备 ISO27001 认证"},
    ]


def test_read_node_multifile_one_failure_still_delivers(monkeypatch, submit_gateway):
    """一个文件解析失败（存储抖动/损坏）→ 跳过，其余文件照常合并交付（不崩整体读标）。"""
    def fake(key):
        if key == "b/broken.pdf":
            raise RuntimeError("下载失败")
        return _DOC1
    monkeypatch.setattr(read_mod, "read_and_parse", fake)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))
    state = {"file_key": "a/gonggao.docx",
             "files": [{"key": "a/gonggao.docx", "name": "采购公告.docx"},
                       {"key": "b/broken.pdf", "name": "损坏文件.pdf"}]}
    out = asyncio.run(read_mod.make_read_node(ctx)(state))
    assert out["read"]["doc_files"] == [{"name": "采购公告.docx", "sec_from": 1, "sec_to": 2}]
    assert out["read"]["doc_sections"] == _DOC1.clauses
    assert out["read"]["risk_summary"] == ["缺 ISO27001 即废标"]


def test_read_node_multifile_prompt_has_file_list_and_all_clauses(monkeypatch, submit_gateway):
    """prompt 需同时包含文件清单（文件N《name》=章节 from..to）与全部文件的条款文本。"""
    by_key = {"a/gonggao.docx": _DOC1, "b/jishu.pdf": _DOC2}
    monkeypatch.setattr(read_mod, "read_and_parse", lambda key: by_key[key])
    captured: dict = {}

    class _FakeResult:
        def model_dump(self):
            return _READ_ARGS

    async def fake_run_submit_agent(ctx, prompt, user_msg, *a, **kw):
        captured["user_msg"] = user_msg
        return _FakeResult()
    monkeypatch.setattr(read_mod, "run_submit_agent", fake_run_submit_agent)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({}))
    state = {"file_key": "a/gonggao.docx",
             "files": [{"key": "a/gonggao.docx", "name": "采购公告.docx"},
                       {"key": "b/jishu.pdf", "name": "技术规范书.pdf"}]}
    asyncio.run(read_mod.make_read_node(ctx)(state))
    msg = captured["user_msg"]
    assert "文件1《采购公告.docx》＝章节 1..2" in msg
    assert "文件2《技术规范书.pdf》＝章节 3..3" in msg
    assert "项目名称：某某平台建设" in msg
    assert "★须具备 ISO27001 认证" in msg


def test_read_node_single_file_path_unchanged_when_no_files(monkeypatch, submit_gateway):
    """Global Constraint：files 缺省/空 → 单文件行为逐字节不变，read 结果不带 doc_files。"""
    monkeypatch.setattr(read_mod, "read_and_parse", lambda key: _DOC1)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "a/gonggao.docx"}))
    assert "doc_files" not in out["read"]
    assert out["read"]["doc_sections"] == _DOC1.clauses


def test_large_clause_count_triggers_segmented_read(monkeypatch, submit_gateway):
    """大标书分段读标:骨架轮 + 技术按条款分块(多包件标 3 包技术需求单轮必超 8k 输出)。
    条款数 = THRESHOLD+1,以 TECH_CHUNK_CLAUSES 分块 → 1 骨架轮 + ceil((THRESHOLD+1)/CHUNK) 技术块。"""
    import math
    import agent.agents.bidding_agent.nodes.read as read_mod

    n = read_mod.SEGMENT_CLAUSE_THRESHOLD + 1
    big = [{"id": f"sec-1-c{i}", "text": f"条款{i}"} for i in range(n)]

    async def fake_parse_multi(files):
        return big, [{"name": "采购文件", "sec_from": 1, "sec_to": 1}]

    monkeypatch.setattr(read_mod, "_parse_multi_files", fake_parse_multi)
    args = {"submit_read_result": {
        "categories": [
            {"key": "overview", "title": "概况", "items": []},
            {"key": "technical", "title": "技术", "items": [{"title": "t", "value": "v"}]},
        ]}}
    gw = submit_gateway(args)
    ctx = RunContext(run_id="r-seg", agent_type="bidding_agent", thread_id="t-seg", gateway=gw)
    out = asyncio.run(read_mod.make_read_node(ctx)({
        "file_key": "a.docx", "files": [{"key": "a.docx", "name": "采购文件"}]}))

    tech_chunks = math.ceil(n / read_mod.TECH_CHUNK_CLAUSES)
    assert len(gw.chats) == 3 + tech_chunks             # 基础/格式/评分 3 骨架轮 + N 技术块
    assert "基础轮" in str(gw.chats[0].last_messages[-1].content)
    assert "格式构成轮" in str(gw.chats[1].last_messages[-1].content)
    assert "评分轮" in str(gw.chats[2].last_messages[-1].content)
    assert "技术第 1/" in str(gw.chats[3].last_messages[-1].content)
    # 合并后 technical 项 = 每个技术块各贡献 1 项(fake 每轮回同一 args)
    tech = next(c for c in out["read"]["categories"] if c["key"] == "technical")
    assert len(tech["items"]) == tech_chunks
    # 合并:pass1 的非 technical + pass2 的 technical
    keys = [c["key"] for c in out["read"]["categories"]]
    assert "technical" in keys and "overview" in keys


def test_small_clause_count_single_submission(monkeypatch, submit_gateway):
    """阈值以内仍单轮提交(现状行为不回归)。"""
    import agent.agents.bidding_agent.nodes.read as read_mod

    async def fake_parse_multi(files):
        return [{"id": "sec-1-c1", "text": "条款"}], [{"name": "f", "sec_from": 1, "sec_to": 1}]

    monkeypatch.setattr(read_mod, "_parse_multi_files", fake_parse_multi)
    gw = submit_gateway({"submit_read_result": {"categories": [{"key": "overview", "title": "概况", "items": []}]}})
    ctx = RunContext(run_id="r-one", agent_type="bidding_agent", thread_id="t-one", gateway=gw)
    asyncio.run(read_mod.make_read_node(ctx)({
        "file_key": "a.docx", "files": [{"key": "a.docx", "name": "f"}]}))
    assert len(gw.chats) == 1
