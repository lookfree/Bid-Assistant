"""spec316 A1: POST/DELETE /rag/index —— TestClient + monkeypatch embedder/store,不打真实依赖。"""
from fastapi.testclient import TestClient

from agent.app import create_app
import agent.routes.rag as rag_route


class _FakeEmbedder:
    def __init__(self, healthy=True, vectors=None, embed_exc=None):
        self._healthy = healthy
        self._vectors = vectors
        self._embed_exc = embed_exc

    async def health(self):
        return self._healthy

    async def embed(self, texts):
        if self._embed_exc:
            raise self._embed_exc
        return self._vectors if self._vectors is not None else [[0.1]] * len(texts)


class _FakeStore:
    def __init__(self):
        self.upsert_calls: list[tuple] = []
        self.delete_calls: list[tuple] = []

    def upsert(self, pool, user_id, source_type, source_id, chunks, embeddings, metas):
        self.upsert_calls.append((user_id, source_type, source_id, chunks, embeddings, metas))
        return len(chunks)

    def delete(self, pool, user_id, source_type, source_id):
        self.delete_calls.append((user_id, source_type, source_id))


def _client(monkeypatch, embedder=None, store=None):
    monkeypatch.setattr(rag_route, "embedder", embedder or _FakeEmbedder())
    monkeypatch.setattr(rag_route, "store", store or _FakeStore())
    return TestClient(create_app())


_BODY = {
    "user_id": "u1",
    "source_type": "library",
    "source_id": "src1",
    "title": "资质证明",
    "text": "投标人具备建筑工程施工总承包壹级资质。",
}


def test_index_success_returns_chunk_count(monkeypatch):
    fake_store = _FakeStore()
    client = _client(monkeypatch, store=fake_store)
    res = client.post("/rag/index", json=_BODY)
    assert res.status_code == 200
    body = res.json()
    assert body["chunks"] >= 1
    assert "disabled" not in body
    assert len(fake_store.upsert_calls) == 1
    call = fake_store.upsert_calls[0]
    assert call[0] == "u1" and call[1] == "library" and call[2] == "src1"


def test_index_disabled_when_embedder_unhealthy(monkeypatch):
    fake_store = _FakeStore()
    client = _client(monkeypatch, embedder=_FakeEmbedder(healthy=False), store=fake_store)
    res = client.post("/rag/index", json=_BODY)
    assert res.status_code == 200
    assert res.json() == {"chunks": 0, "disabled": True}
    assert fake_store.upsert_calls == []


def test_index_embed_failure_returns_readable_error_not_crash(monkeypatch):
    client = _client(monkeypatch, embedder=_FakeEmbedder(embed_exc=RuntimeError("embed 服务超时")))
    res = client.post("/rag/index", json=_BODY)
    assert res.status_code == 500
    body = res.json()
    assert body["chunks"] == 0
    assert "embed" in body["error"] or "超时" in body["error"]


def test_delete_index_calls_store_with_owner(monkeypatch):
    fake_store = _FakeStore()
    client = _client(monkeypatch, store=fake_store)
    res = client.request("DELETE", "/rag/index/library/src1", params={"user_id": "owner-1"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert fake_store.delete_calls == [("owner-1", "library", "src1")]
