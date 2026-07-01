from types import SimpleNamespace
from agent.models.usage import extract_usage


def test_extract_usage_from_usage_metadata():
    msg = SimpleNamespace(
        usage_metadata={
            "input_tokens": 1200,
            "output_tokens": 300,
            "total_tokens": 1500,
            "input_token_details": {"cache_read": 800},
            "output_token_details": {"reasoning": 150},
        },
        response_metadata={"finish_reason": "stop"},
    )
    u = extract_usage(msg)
    assert u == {"input": 1200, "output": 300, "cached": 800, "reasoning": 150, "total": 1500, "finish_reason": "stop"}


def test_extract_usage_defaults_when_missing():
    msg = SimpleNamespace(usage_metadata=None, response_metadata={})
    u = extract_usage(msg)
    assert u["input"] == 0 and u["output"] == 0 and u["cached"] == 0 and u["reasoning"] == 0 and u["total"] == 0
