from types import SimpleNamespace

from fastapi.testclient import TestClient

from agent.app import create_app
import agent.routes.models as models_route


def _fake_resp(total_tokens=42):
    return SimpleNamespace(usage_metadata={"total_tokens": total_tokens})


class _FakeChat:
    def __init__(self, resp=None, exc=None):
        self._resp = resp
        self._exc = exc

    async def ainvoke(self, _messages):
        if self._exc:
            raise self._exc
        return self._resp


class _FakeGateway:
    """monkeypatch 目标：按用例定制 get_chat 行为，绕开真实 ChatOpenAI/网络。"""

    def __init__(self, chat=None, raise_err=None):
        self._chat = chat
        self._raise_err = raise_err
        self.last_kwargs: dict | None = None   # 记录 get_chat 最近一次入参，供自建端点用例断言透传

    def get_chat(self, provider, model=None, **kw):
        self.last_kwargs = {"provider": provider, "model": model, **kw}
        if self._raise_err:
            raise self._raise_err
        return self._chat


def _patch_gateway(monkeypatch, gw):
    monkeypatch.setattr(models_route, "ModelGateway", lambda settings: gw)


class _FakeHttpResp:
    """monkeypatch 目标：伪造 httpx.Response，避免真实网络请求。"""

    def __init__(self, json_data=None, status_error=None):
        self._json = json_data
        self._status_error = status_error

    def raise_for_status(self):
        if self._status_error:
            raise self._status_error

    def json(self):
        return self._json


class _FakeAsyncClient:
    def __init__(self, resp=None, exc=None):
        self._resp = resp
        self._exc = exc
        self.calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def get(self, url, headers=None):
        self.calls.append({"url": url, "headers": headers})
        if self._exc:
            raise self._exc
        return self._resp


class _FakeHttpx:
    """替换 models_route 里的 httpx 模块引用（只影响该模块，不动全局 httpx）。"""

    def __init__(self, resp=None, exc=None):
        self._client = _FakeAsyncClient(resp=resp, exc=exc)
        self.AsyncClient = lambda *a, **kw: self._client


def _patch_httpx(monkeypatch, resp=None, exc=None):
    fake = _FakeHttpx(resp=resp, exc=exc)
    monkeypatch.setattr(models_route, "httpx", fake)
    return fake


def test_models_test_success(monkeypatch):
    client = TestClient(create_app())
    _patch_gateway(monkeypatch, _FakeGateway(chat=_FakeChat(resp=_fake_resp(7))))
    res = client.post("/models/test", json={"provider": "deepseek"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["tokens"] == 7
    assert body["latency_ms"] >= 0


def test_models_test_missing_api_key(monkeypatch):
    client = TestClient(create_app())
    _patch_gateway(monkeypatch, _FakeGateway(raise_err=RuntimeError("缺少 API Key")))
    res = client.post("/models/test", json={"provider": "deepseek"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "API Key" in body["error"]


def test_models_test_ainvoke_exception_returns_200(monkeypatch):
    client = TestClient(create_app())
    _patch_gateway(monkeypatch, _FakeGateway(chat=_FakeChat(exc=RuntimeError("model exploded"))))
    res = client.post("/models/test", json={"provider": "deepseek"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "model exploded" in body["error"]


def test_models_test_unknown_provider_400():
    client = TestClient(create_app())
    res = client.post("/models/test", json={"provider": "gpt"})
    assert res.status_code == 400


def test_models_test_custom_endpoint_passes_base_url(monkeypatch):
    """provider 不在白名单，但带 base_url ⇒ 不 400，且 get_chat 收到透传的 base_url/api_key。"""
    client = TestClient(create_app())
    gw = _FakeGateway(chat=_FakeChat(resp=_fake_resp(3)))
    _patch_gateway(monkeypatch, gw)
    res = client.post(
        "/models/test",
        json={"provider": "custom", "model": "qwen-x", "base_url": "http://h:8000/v1", "api_key": "sk-x"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert gw.last_kwargs["base_url"] == "http://h:8000/v1"
    assert gw.last_kwargs["api_key"] == "sk-x"
    assert gw.last_kwargs["model"] == "qwen-x"


def test_models_list_models_success(monkeypatch):
    client = TestClient(create_app())
    fake_httpx = _patch_httpx(
        monkeypatch,
        resp=_FakeHttpResp(json_data={"data": [{"id": "qwen2.5-72b"}, {"id": "qwen2.5-7b"}]}),
    )
    res = client.post("/models/list-models", json={"base_url": "http://h:8000/v1", "api_key": "sk-x"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["models"] == ["qwen2.5-72b", "qwen2.5-7b"]
    call = fake_httpx._client.calls[0]
    assert call["url"] == "http://h:8000/v1/models"
    assert call["headers"]["Authorization"] == "Bearer sk-x"


def test_models_list_models_caps_at_100(monkeypatch):
    client = TestClient(create_app())
    items = [{"id": f"m{i}"} for i in range(150)]
    _patch_httpx(monkeypatch, resp=_FakeHttpResp(json_data={"data": items}))
    res = client.post("/models/list-models", json={"base_url": "http://h:8000/v1", "api_key": "sk-x"})
    body = res.json()
    assert body["ok"] is True
    assert len(body["models"]) == 100


def test_models_list_models_timeout_returns_ok_false_200(monkeypatch):
    client = TestClient(create_app())
    _patch_httpx(monkeypatch, exc=TimeoutError("timed out"))
    res = client.post("/models/list-models", json={"base_url": "http://h:8000/v1", "api_key": "sk-x"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "error" in body


def test_models_list_models_http_error_returns_ok_false_200(monkeypatch):
    client = TestClient(create_app())
    _patch_httpx(monkeypatch, resp=_FakeHttpResp(status_error=RuntimeError("401 unauthorized")))
    res = client.post("/models/list-models", json={"base_url": "http://h:8000/v1", "api_key": "sk-bad"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "401" in body["error"]
