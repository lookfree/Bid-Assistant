from fastapi.testclient import TestClient
from agent.app import create_app


def test_readyz_ok():
    client = TestClient(create_app())
    res = client.get("/readyz")
    assert res.status_code == 200
    body = res.json()
    assert body["pg"] == "up"
    assert body["redis"] == "up"
