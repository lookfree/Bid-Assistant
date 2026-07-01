from agent.framework import hitl


def test_human_review_builds_interrupt_payload(monkeypatch):
    captured = {}
    monkeypatch.setattr(hitl, "interrupt", lambda v: captured.setdefault("v", v) or v)
    hitl.human_review(hitl.ReviewType.OUTLINE_CONFIRM, {"outline": ["第一章"]}, timeout_seconds=120)
    v = captured["v"]
    assert v["type"] == "hitl.required"
    assert v["review_type"] == "outline_confirm"
    assert v["details"]["outline"] == ["第一章"]
    assert v["timeout_seconds"] == 120
