import asyncio
import pytest
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


def test_segmented_read_runs_rounds_concurrently(monkeypatch, submit_gateway):
    """并行提取回归:分段各轮必须并发跑(墙钟≈最慢一批,非累加)。
    fake 每轮 sleep 一拍并记录在途数,峰值在途 >1 即证明未被串行化;同时不超 SEG_CONCURRENCY。"""
    import agent.agents.bidding_agent.nodes.read as read_mod

    n = read_mod.SEGMENT_CLAUSE_THRESHOLD + 1
    big = [{"id": f"sec-1-c{i}", "text": f"条款{i}"} for i in range(n)]

    async def fake_parse_multi(files):
        return big, [{"name": "采购文件", "sec_from": 1, "sec_to": 1}]
    monkeypatch.setattr(read_mod, "_parse_multi_files", fake_parse_multi)

    inflight = {"now": 0, "peak": 0}
    real_seg_submit = read_mod._seg_submit

    async def slow_seg_submit(ctx, user, hint, label):
        inflight["now"] += 1
        inflight["peak"] = max(inflight["peak"], inflight["now"])
        await asyncio.sleep(0.05)   # 给并发重叠留出窗口
        try:
            return await real_seg_submit(ctx, user, hint, label)
        finally:
            inflight["now"] -= 1
    monkeypatch.setattr(read_mod, "_seg_submit", slow_seg_submit)

    args = {"submit_read_result": {"categories": [{"key": "overview", "title": "概况", "items": []}]}}
    ctx = RunContext(run_id="r-par", agent_type="bidding_agent", thread_id="t-par", gateway=submit_gateway(args))
    asyncio.run(read_mod.make_read_node(ctx)({
        "file_key": "a.docx", "files": [{"key": "a.docx", "name": "采购文件"}]}))

    assert inflight["peak"] > 1                                  # 真并发,没有被串行化
    assert inflight["peak"] <= read_mod.SEG_CONCURRENCY          # 且被信号量限住


def test_segmented_read_resumes_from_cache_on_retry(monkeypatch, submit_gateway):
    """断点续跑回归(92 块标书 14/95 失败重试全重烧之痛):首跑某轮失败 → 成功轮已存 Redis 缓存;
    重试时命中缓存的轮不再调模型,只重跑失败的那轮。"""
    import agent.agents.bidding_agent.nodes.read as read_mod

    n = read_mod.SEGMENT_CLAUSE_THRESHOLD + 1     # 201 条 → 3 技术块 + 3 骨架 = 6 轮
    big = [{"id": f"sec-1-c{i}", "text": f"条款{i}"} for i in range(n)]

    async def fake_parse_multi(files):
        return big, [{"name": "采购文件", "sec_from": 1, "sec_to": 1}]
    monkeypatch.setattr(read_mod, "_parse_multi_files", fake_parse_multi)

    class _FakeRedis:                                # 极简 get/set(str) 假 redis
        def __init__(self):
            self.kv: dict[str, str] = {}

        def get(self, k):
            return self.kv.get(k)

        def set(self, k, v, ex=None):
            self.kv[k] = v

    calls = {"n": 0}
    real_seg_submit = read_mod._seg_submit

    async def failing_seg_submit(ctx, user, hint, label):
        calls["n"] += 1
        if "技术第2/" in label:                       # 首跑:技术第2块失败
            raise RuntimeError("peer closed connection")
        return await real_seg_submit(ctx, user, hint, label)
    monkeypatch.setattr(read_mod, "_seg_submit", failing_seg_submit)

    args = {"submit_read_result": {"categories": [{"key": "overview", "title": "概况", "items": []}]}}
    redis = _FakeRedis()
    state = {"file_key": "a.docx", "files": [{"key": "a.docx", "name": "采购文件"}]}
    ctx1 = RunContext(run_id="r1", agent_type="bidding_agent", thread_id="t-resume",
                      gateway=submit_gateway(args), redis=redis)
    with pytest.raises(RuntimeError, match="peer closed"):
        asyncio.run(read_mod.make_read_node(ctx1)(state))
    assert calls["n"] == 6                           # 6 轮都跑了(不因单轮失败取消其他轮)
    assert len(redis.kv) == 5                        # 成功的 5 轮已存档

    # 重试(同 thread、同文档):5 轮命中缓存,只重跑失败的技术第2块 → 模型只多调 1 次
    monkeypatch.setattr(read_mod, "_seg_submit", real_seg_submit)
    gw2 = submit_gateway(args)
    ctx2 = RunContext(run_id="r2", agent_type="bidding_agent", thread_id="t-resume",
                      gateway=gw2, redis=redis)
    out = asyncio.run(read_mod.make_read_node(ctx2)(state))
    assert len(gw2.chats) == 1                       # 只有失败那轮真正调了模型
    assert "categories" in out["read"]


def test_tech_chunk_rounds_carry_only_own_chunk(monkeypatch, submit_gateway):
    """瘦身回归(1MB 标书实测:每块都带全文 → 单轮 prefill ~4 分钟、输入重复计费 92 次):
    技术块轮消息只含本块条款;骨架轮(基础/格式/评分)仍带全文。"""
    import agent.agents.bidding_agent.nodes.read as read_mod

    n = read_mod.SEGMENT_CLAUSE_THRESHOLD + 1     # 201 条 → 3 块(块大小 100)
    big = [{"id": f"sec-1-c{i}", "text": f"条款{i}"} for i in range(n)]

    async def fake_parse_multi(files):
        return big, [{"name": "采购文件", "sec_from": 1, "sec_to": 1}]
    monkeypatch.setattr(read_mod, "_parse_multi_files", fake_parse_multi)

    args = {"submit_read_result": {"categories": [{"key": "overview", "title": "概况", "items": []}]}}
    gw = submit_gateway(args)
    ctx = RunContext(run_id="r-slim", agent_type="bidding_agent", thread_id="t-slim", gateway=gw)
    asyncio.run(read_mod.make_read_node(ctx)({
        "file_key": "a.docx", "files": [{"key": "a.docx", "name": "采购文件"}]}))

    msgs = [str(c.last_messages[-1].content) for c in gw.chats]
    base_msg = next(m for m in msgs if "基础轮" in m)
    tech1 = next(m for m in msgs if "技术第 1/" in m)
    assert "条款0" in base_msg and f"条款{n - 1}" in base_msg   # 骨架轮带全文
    assert "条款0" in tech1 and "条款150" not in tech1          # 技术第1块只含自己那 100 条
    tech2 = next(m for m in msgs if "技术第 2/" in m)
    assert "条款150" in tech2 and '"条款0"' not in tech2        # 第2块含 150、不含第1块的条款


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
