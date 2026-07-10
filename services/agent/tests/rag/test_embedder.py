"""spec316 A1: embedder —— mock httpx,不打真实 bge-embed。批量>16 分批;探活失败降级。"""
import httpx

import agent.rag.embedder as embedder_mod
from agent.rag.embedder import BATCH_SIZE, Embedder

ENDPOINT = "http://bge-embed:8000/v1/embeddings"


class _FakeResponse:
    def __init__(self, json_data, status_code=200):
        self._json = json_data
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=self)  # type: ignore[arg-type]

    def json(self):
        return self._json


class _FakeAsyncClient:
    """记录每次 get/post 调用,按预设脚本回放响应(或抛异常)。"""

    instances: list["_FakeAsyncClient"] = []

    def __init__(self, *args, **kwargs):
        self.calls: list[tuple] = []
        self.timeout = kwargs.get("timeout")
        _FakeAsyncClient.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        self.calls.append(("post", url, json))
        batch = json["input"]
        data = [{"embedding": [0.1] * 3} for _ in batch]
        return _FakeResponse({"data": data})


def _install_fake_client(monkeypatch, get_result=None, get_exc=None):
    _FakeAsyncClient.instances = []

    class _Client(_FakeAsyncClient):
        async def get(self, url):
            self.calls.append(("get", url))
            if get_exc:
                raise get_exc
            return get_result

    monkeypatch.setattr(embedder_mod.httpx, "AsyncClient", _Client)
    return _Client


async def test_embed_returns_vectors_for_each_text(monkeypatch):
    _install_fake_client(monkeypatch)
    e = Embedder(ENDPOINT)
    vectors = await e.embed(["段落一", "段落二"])
    assert len(vectors) == 2
    assert all(len(v) == 3 for v in vectors)


async def test_embed_batches_over_16_into_multiple_requests(monkeypatch):
    client_cls = _install_fake_client(monkeypatch)
    e = Embedder(ENDPOINT)
    texts = [f"块{i}" for i in range(20)]
    vectors = await e.embed(texts)
    assert len(vectors) == 20
    post_calls = [c for inst in client_cls.instances for c in inst.calls if c[0] == "post"]
    assert len(post_calls) == 2
    assert len(post_calls[0][2]["input"]) == BATCH_SIZE
    assert len(post_calls[1][2]["input"]) == 20 - BATCH_SIZE


async def test_embed_empty_list_returns_empty_without_request(monkeypatch):
    client_cls = _install_fake_client(monkeypatch)
    e = Embedder(ENDPOINT)
    assert await e.embed([]) == []
    assert client_cls.instances == []


async def test_health_true_when_probe_succeeds(monkeypatch):
    _install_fake_client(monkeypatch, get_result=_FakeResponse({}, status_code=200))
    e = Embedder(ENDPOINT)
    assert await e.health() is True


async def test_health_false_when_probe_fails(monkeypatch):
    _install_fake_client(monkeypatch, get_exc=httpx.ConnectError("refused", request=None))
    e = Embedder(ENDPOINT)
    assert await e.health() is False


async def test_health_false_when_probe_returns_non_200(monkeypatch):
    _install_fake_client(monkeypatch, get_result=_FakeResponse({}, status_code=503))
    e = Embedder(ENDPOINT)
    assert await e.health() is False
