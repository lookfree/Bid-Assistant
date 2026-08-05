"""模型连通性测试的报错要让运营看得懂，并且说清下一步。

2026-08-05 实测（运营后台「新增模型」）：模型名误填成 test，界面原样吐出上游报文——
  Error code: 503 - {'error': {'code': 'model_not_found', 'message': 'No available channel
  for model test under group Business-gpt (distributor) (request id: 2026080510461610...)'}}
运营从这段英文里既看不出"是模型名不存在"，也不知道该改哪里。
"""
from agent.models.errors import friendly_model_error


def err(msg: str) -> Exception:
    return RuntimeError(msg)


class TestClassification:
    def test_model_not_found_points_at_the_model_name(self):
        m = friendly_model_error(err(
            "Error code: 503 - {'error': {'code': 'model_not_found', 'message': "
            "'No available channel for model test under group Business-gpt'}}"))
        assert "模型名" in m
        assert "不存在" in m or "找不到" in m

    def test_auth_failure_points_at_the_key(self):
        for raw in ("Error code: 401 - Unauthorized",
                    "Incorrect API key provided: sk-xxx",
                    "Error code: 403 - {'error': 'forbidden'}"):
            m = friendly_model_error(err(raw))
            assert "API Key" in m or "密钥" in m

    def test_rate_limit(self):
        m = friendly_model_error(err("Error code: 429 - rate_limit_exceeded"))
        assert "频繁" in m or "限流" in m or "额度" in m

    def test_connection_failure_points_at_the_address(self):
        for raw in ("Connection error.", "Failed to establish a new connection", "timed out"):
            m = friendly_model_error(err(raw))
            assert "连接" in m or "地址" in m or "超时" in m

    def test_upstream_5xx_is_not_reported_as_our_fault(self):
        m = friendly_model_error(err("Error code: 502 - Bad Gateway"))
        assert "服务" in m

    def test_bad_request(self):
        m = friendly_model_error(err("Error code: 400 - {'error': {'message': 'invalid parameter'}}"))
        assert "参数" in m or "拒绝" in m


class TestAlwaysUsable:
    def test_original_text_is_kept_for_diagnosis(self):
        """翻译不能把原文吃掉——真排查时那串 request id 是唯一线索。"""
        m = friendly_model_error(err("Error code: 503 - model_not_found (request id: abc123)"))
        assert "abc123" in m

    def test_unknown_error_still_returns_something_readable(self):
        m = friendly_model_error(err("完全没见过的错误"))
        assert "完全没见过的错误" in m
        assert m.strip()

    def test_walks_the_cause_chain(self):
        """真因常被 SDK 包一层：str(顶层) 只有 'Connection error.'（本仓韧性铁律）。"""
        inner = err("Error code: 401 - Unauthorized")
        outer = RuntimeError("Connection error.")
        outer.__cause__ = inner
        m = friendly_model_error(outer)
        assert "API Key" in m or "密钥" in m

    def test_output_is_bounded(self):
        """界面上是一小块红字，别把几 KB 的上游 JSON 全糊上去。"""
        m = friendly_model_error(err("x" * 5000))
        assert len(m) <= 400


class TestNoFalsePositive:
    def test_request_id_digits_are_not_read_as_status_codes(self):
        """报文里的 request id 是长数字串，裸匹配 "401"/"503" 会撞上它，
        把「模型名不存在」误报成「密钥无效」——运营会去改一个本来是对的密钥。"""
        m = friendly_model_error(err(
            "Error code: 503 - {'error': {'code': 'model_not_found', 'message': "
            "'No available channel for model test (request id: 20260805104016429503888)'}}"))
        assert "模型名" in m
        # 不能被误判成鉴权问题（"该密钥下不可用" 是模型名那条文案里的正常措辞，
        # 故按鉴权提示的特征句断言，而不是按"密钥"两个字）
        assert "无效或已失效" not in m

    def test_status_code_only_counts_when_it_is_actually_the_status(self):
        m = friendly_model_error(err("请求 id 4290000429 处理失败"))
        assert "频繁" not in m and "限流" not in m
