from fastapi.testclient import TestClient
from agent.app import create_app


def test_healthz():
    client = TestClient(create_app())
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
