import asyncio
from agent.runtime.registry import RunContext
from agent.parsing.types import ParsedDoc
from agent.agents.bidding_agent.nodes import read as read_mod

_READ_ARGS = {
    "categories": [{"key": "qualification", "title": "资格要求",
                    "items": [{"title": "★ISO27001", "value": "不可偏离", "risk": True, "star": True}]}],
    "risk_summary": ["缺 ISO27001 即废标"],
}
_CLAUSES = [{"id": "sec-1-c1", "text": "项目名称：某某平台建设"},
            {"id": "sec-2-c1", "text": "投标人须具备 ISO27001 认证"}]


def test_read_node_emits_doc_sections(monkeypatch, submit_gateway):
    """spec315a：节点确定性解析一次 → doc_sections 并入 read result（不设独立 state 通道，
    唯一消费方是前端左栏，双份落地徒增 checkpoint 体积）。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/tender.docx"}))
    assert out["read"]["doc_sections"] == _CLAUSES              # 随 result 交付前端
    assert "doc_sections" not in out                            # 不再写独立通道
    assert out["read"]["risk_summary"] == ["缺 ISO27001 即废标"]  # 结构化读标不受影响


def test_read_node_degrades_when_parse_fails(monkeypatch, submit_gateway):
    def boom(key):
        raise RuntimeError("存储抖动")
    monkeypatch.setattr(read_mod, "read_and_parse", boom)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))
    out = asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/broken.pdf"}))
    assert out["read"]["doc_sections"] == []
    assert out["read"]["risk_summary"] == ["缺 ISO27001 即废标"]


class _FakeEmbedder:
    def __init__(self, vectors=None, exc=None):
        self.vectors = vectors
        self.exc = exc
        self.embed_calls: list[list[str]] = []

    async def embed(self, texts):
        self.embed_calls.append(texts)
        if self.exc:
            raise self.exc
        return self.vectors if self.vectors is not None else [[0.1]] * len(texts)


class _FakeRagRetrieve:
    """桩 rag_retrieve 模块：只实现 read 节点用到的 rag_enabled + embedder。"""

    def __init__(self, enabled=True, embedder=None):
        self.enabled = enabled
        self.embedder = embedder or _FakeEmbedder()
        self.enabled_calls: list[tuple] = []

    async def rag_enabled(self, user_id, run_input):
        self.enabled_calls.append((user_id, run_input))
        return self.enabled


class _FakeRagStore:
    def __init__(self, exc=None):
        self.upsert_calls: list[tuple] = []
        self.exc = exc

    def upsert(self, pool, user_id, source_type, source_id, texts, vectors, metas):
        if self.exc:
            raise self.exc
        self.upsert_calls.append((user_id, source_type, source_id, texts, vectors, metas))
        return len(texts)


def test_read_node_indexes_tender_when_rag_enabled(monkeypatch, submit_gateway):
    """spec316 A2：rag.enabled 且 user_id 存在 → best-effort 索引 tender 分句
    （逐句已是 clause，不再过 chunker）；索引不影响 read 交付。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    fake_rag = _FakeRagRetrieve(enabled=True)
    fake_store = _FakeRagStore()
    monkeypatch.setattr(read_mod, "rag_retrieve", fake_rag)
    monkeypatch.setattr(read_mod, "rag_store", fake_store)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), user_id="u1")
    out = asyncio.run(read_mod.make_read_node(ctx)(
        {"file_key": "uploads/x/tender.docx", "run_input": {"rag": {"enabled": True}}}))
    assert out["read"]["doc_sections"] == _CLAUSES
    assert len(fake_store.upsert_calls) == 1
    user_id, source_type, source_id, texts, _vectors, metas = fake_store.upsert_calls[0]
    assert (user_id, source_type, source_id) == ("u1", "tender", "t")
    assert texts == [c["text"] for c in _CLAUSES]
    assert metas == [{"clause_id": c["id"]} for c in _CLAUSES]


def test_read_node_index_failure_does_not_break_read(monkeypatch, submit_gateway):
    """索引失败（embed/store 任一抛错）只 warning，read 结果照常返回。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    fake_rag = _FakeRagRetrieve(enabled=True)
    fake_store = _FakeRagStore(exc=RuntimeError("db 抖动"))
    monkeypatch.setattr(read_mod, "rag_retrieve", fake_rag)
    monkeypatch.setattr(read_mod, "rag_store", fake_store)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), user_id="u1")
    out = asyncio.run(read_mod.make_read_node(ctx)(
        {"file_key": "uploads/x/tender.docx", "run_input": {"rag": {"enabled": True}}}))
    assert out["read"]["doc_sections"] == _CLAUSES
    assert out["read"]["risk_summary"] == ["缺 ISO27001 即废标"]


def test_read_node_skips_index_when_rag_disabled(monkeypatch, submit_gateway):
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    fake_rag = _FakeRagRetrieve(enabled=False)
    fake_store = _FakeRagStore()
    monkeypatch.setattr(read_mod, "rag_retrieve", fake_rag)
    monkeypatch.setattr(read_mod, "rag_store", fake_store)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), user_id="u1")
    asyncio.run(read_mod.make_read_node(ctx)({"file_key": "uploads/x/tender.docx"}))
    assert fake_store.upsert_calls == []


class _RaisingRag:
    async def rag_enabled(self, user_id, run_input):
        raise RuntimeError("gate boom")


def test_read_node_gate_exception_does_not_break_read(monkeypatch, submit_gateway):
    """spec316 A2 harden：rag_enabled 抛错 → 视为 RAG off，read 结果照常返回、不索引。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    fake_store = _FakeRagStore()
    monkeypatch.setattr(read_mod, "rag_retrieve", _RaisingRag())
    monkeypatch.setattr(read_mod, "rag_store", fake_store)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}), user_id="u1")
    out = asyncio.run(read_mod.make_read_node(ctx)(
        {"file_key": "uploads/x/tender.docx", "run_input": {"rag": {"enabled": True}}}))
    assert out["read"]["doc_sections"] == _CLAUSES
    assert fake_store.upsert_calls == []


def test_read_node_skips_index_when_no_user_id(monkeypatch, submit_gateway):
    """无 user_id → 不索引；真实（未打桩）rag_retrieve 短路跳过，不发起任何网络调用。"""
    monkeypatch.setattr(read_mod, "read_and_parse",
                        lambda key: ParsedDoc(text="全文", kind="docx", clauses=_CLAUSES))
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({"submit_read_result": _READ_ARGS}))  # 无 user_id
    out = asyncio.run(read_mod.make_read_node(ctx)(
        {"file_key": "uploads/x/tender.docx", "run_input": {"rag": {"enabled": True}}}))
    assert out["read"]["doc_sections"] == _CLAUSES
