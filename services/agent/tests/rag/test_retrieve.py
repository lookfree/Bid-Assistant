"""spec316 A2: build_reference_block / rag_enabled —— mock embedder/store，best-effort 兜底,
任何异常/无命中都不能阻塞生成主链路（fixture 全部本地 fake，不打真实依赖）。"""
import asyncio

import agent.rag.retrieve as retrieve_mod
from agent.rag.retrieve import REF_HEADER, build_reference_block, rag_enabled


class _FakeEmbedder:
    def __init__(self, healthy=True, vectors=None, embed_exc=None):
        self._healthy = healthy
        self._vectors = vectors
        self._embed_exc = embed_exc
        self.embed_calls: list[list[str]] = []

    async def health(self):
        return self._healthy

    async def embed(self, texts):
        self.embed_calls.append(texts)
        if self._embed_exc:
            raise self._embed_exc
        return self._vectors if self._vectors is not None else [[0.1]] * len(texts)


class _FakeStore:
    def __init__(self, library_hits=None, tender_hits=None, exc=None):
        self.library_hits = library_hits or []
        self.tender_hits = tender_hits or []
        self.exc = exc
        self.search_calls: list[tuple] = []

    def search(self, pool, user_id, source_type, query_vec, top_k=5, source_id=None):
        self.search_calls.append((user_id, source_type, top_k, source_id))
        if self.exc:
            raise self.exc
        return self.tender_hits if source_type == "tender" else self.library_hits


def _patch(monkeypatch, embedder=None, store=None):
    monkeypatch.setattr(retrieve_mod, "embedder", embedder or _FakeEmbedder())
    monkeypatch.setattr(retrieve_mod, "store", store or _FakeStore())
    monkeypatch.setattr(retrieve_mod, "get_pool", lambda: object())


def test_build_reference_block_dedups_and_sorts_by_score(monkeypatch):
    hits = [
        {"text": "A条款", "score": 0.5},
        {"text": "B条款", "score": 0.9},
        {"text": "A条款", "score": 0.4},  # 重复文本，应去重（只保留一次）
    ]
    _patch(monkeypatch, store=_FakeStore(library_hits=hits))
    block = asyncio.run(build_reference_block("u1", ["需求理解"], top_k=5))
    assert block.startswith(REF_HEADER)
    lines = block.splitlines()[1:]
    assert lines == ["- B条款", "- A条款"]


def test_build_reference_block_budget_truncates_long_hits(monkeypatch):
    hit1 = "x" * 50
    hit2 = "y" * 5000
    hits = [{"text": hit1, "score": 1.0}, {"text": hit2, "score": 0.9}]
    _patch(monkeypatch, store=_FakeStore(library_hits=hits))
    block = asyncio.run(build_reference_block("u1", ["q"], top_k=5, budget=200))
    assert hit1 in block
    assert hit2 not in block


def test_build_reference_block_embed_failure_returns_empty(monkeypatch):
    _patch(monkeypatch, embedder=_FakeEmbedder(embed_exc=RuntimeError("embed 超时")))
    block = asyncio.run(build_reference_block("u1", ["q"], top_k=5))
    assert block == ""


def test_build_reference_block_no_hits_returns_empty(monkeypatch):
    _patch(monkeypatch, store=_FakeStore(library_hits=[]))
    block = asyncio.run(build_reference_block("u1", ["q"], top_k=5))
    assert block == ""


def test_build_reference_block_store_exception_swallowed(monkeypatch):
    _patch(monkeypatch, store=_FakeStore(exc=TimeoutError("boom")))
    block = asyncio.run(build_reference_block("u1", ["q"], top_k=5))
    assert block == ""


def test_build_reference_block_empty_queries_returns_empty(monkeypatch):
    _patch(monkeypatch)
    block = asyncio.run(build_reference_block("u1", ["", "  "], top_k=5))
    assert block == ""


def test_build_reference_block_includes_tender_hits_when_thread_given(monkeypatch):
    fake_store = _FakeStore(library_hits=[{"text": "lib1", "score": 0.5}],
                             tender_hits=[{"text": "tender1", "score": 0.9}])
    _patch(monkeypatch, store=fake_store)
    block = asyncio.run(build_reference_block("u1", ["q"], top_k=5, tender_thread_id="t1"))
    assert "tender1" in block and "lib1" in block
    # tender 按 thread 隔离（source_id=tender_thread_id）；library 取全部资料库（source_id=None）
    assert ("u1", "tender", 2, "t1") in fake_store.search_calls
    assert ("u1", "library", 5, None) in fake_store.search_calls


class _SeqStore:
    """library 每次 search 返回序列里的下一组命中（模拟逐 query 检索不同章节命中）；tender 返回空。"""

    def __init__(self, library_seq):
        self.library_seq = library_seq
        self.i = 0
        self.search_calls: list[tuple] = []

    def search(self, pool, user_id, source_type, query_vec, top_k=5, source_id=None):
        self.search_calls.append((user_id, source_type, top_k, source_id))
        if source_type == "tender":
            return []
        hits = self.library_seq[self.i]
        self.i += 1
        return hits


def test_build_reference_block_unions_hits_across_queries(monkeypatch):
    """spec316 A2 fix：逐 query 各查 library、UNION 命中、按 text 去重、score 降序——
    多章文档取到跨章广度，而非一个平均向量拉低相关性。"""
    seq_store = _SeqStore([
        [{"text": "章一命中", "score": 0.8}],
        [{"text": "章二命中", "score": 0.9}, {"text": "章一命中", "score": 0.5}],  # 章一重复→去重
    ])
    _patch(monkeypatch, store=seq_store)
    block = asyncio.run(build_reference_block("u1", ["章一 query", "章二 query"], top_k=3))
    lines = block.splitlines()[1:]
    assert lines == ["- 章二命中", "- 章一命中"]                 # union + dedup + score desc
    lib_calls = [c for c in seq_store.search_calls if c[1] == "library"]
    assert len(lib_calls) == 2                                  # 每个 query 各查一次 library


def test_rag_enabled_false_when_user_id_missing(monkeypatch):
    _patch(monkeypatch)
    assert asyncio.run(rag_enabled(None, {"rag": {"enabled": True}})) is False


def test_rag_enabled_false_when_config_disabled(monkeypatch):
    _patch(monkeypatch)
    assert asyncio.run(rag_enabled("u1", {"rag": {"enabled": False}})) is False


def test_rag_enabled_false_when_run_input_missing_rag_key(monkeypatch):
    _patch(monkeypatch)
    assert asyncio.run(rag_enabled("u1", {})) is False


def test_rag_enabled_false_when_embedder_unhealthy(monkeypatch):
    _patch(monkeypatch, embedder=_FakeEmbedder(healthy=False))
    assert asyncio.run(rag_enabled("u1", {"rag": {"enabled": True}})) is False


def test_rag_enabled_true_when_all_conditions_met(monkeypatch):
    _patch(monkeypatch)
    assert asyncio.run(rag_enabled("u1", {"rag": {"enabled": True}})) is True
