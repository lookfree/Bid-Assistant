"""输入预算：额度由窗口减出来，不是写死的常量。"""
import asyncio

import pytest

from agent.framework.budget import (
    DEFAULT_CONTEXT_WINDOW, _DEFAULT_OUTPUT_RESERVE, MIN_CHAPTER_TOKENS,
    chapter_budget, estimate_tokens, is_context_overflow, run_with_shrink)


class TestEstimate:
    def test_chinese_costs_about_one_token_per_char(self):
        """标定：中文实测 1.15 字/token，我们按 1 字 1 token 保守算。"""
        assert estimate_tokens("投标文件" * 100) == 400

    def test_ascii_is_much_cheaper(self):
        """英文 4 字符 1 token——读标结论那种带大量 ASCII 键名的 JSON，按中文口径估会高估三倍。"""
        assert estimate_tokens("a" * 400) == 100

    def test_empty(self):
        assert estimate_tokens("") == 0


class TestBudget:
    def test_output_quota_is_subtracted(self):
        """后台配的 max_tokens 是从窗口里扣的，不是额外的。"""
        small = chapter_budget("", context_window=131072, max_tokens=32768)
        large = chapter_budget("", context_window=131072, max_tokens=8192)
        assert large - small == pytest.approx((32768 - 8192) * 0.9, abs=2)

    def test_fixed_part_is_subtracted(self):
        """读标结论越大，留给正文的越少——这正是写死常量做不到的。"""
        bare = chapter_budget("", context_window=131072, max_tokens=8192)
        with_read = chapter_budget("读标结论" * 5000, context_window=131072, max_tokens=8192)
        assert bare - with_read == pytest.approx(20000 * 0.9, abs=2)

    def test_bigger_window_gives_more_room(self):
        """推理服务把 --max-model-len 调大后，改配置就该多喂——不用改代码。"""
        assert (chapter_budget("", context_window=262144, max_tokens=32768)
                > chapter_budget("", context_window=131072, max_tokens=32768))

    def test_missing_config_falls_back_to_the_default_window(self):
        assert (chapter_budget("", context_window=None, max_tokens=32768)
                == chapter_budget("", context_window=DEFAULT_CONTEXT_WINDOW, max_tokens=32768))

    def test_missing_max_tokens_still_reserves_output(self):
        """没配 max_tokens 不等于不产出：预留 0 会把整个窗口当输入额度，输出一长又是 400。"""
        assert (chapter_budget("", context_window=131072, max_tokens=None)
                == chapter_budget("", context_window=131072, max_tokens=_DEFAULT_OUTPUT_RESERVE))

    def test_reports_zero_room_instead_of_a_fake_floor(self):
        """固定部分本身就撑爆窗口 → 回 0，让节点当场失败退款。

        以前硬塞一个下限，结果是拿一个注定装不下的载荷去撞三轮 400 才失败——
        收缩重试只动正文，而这种情况超额的是固定部分，缩多少轮都没用。
        """
        assert chapter_budget("超长" * 100000, context_window=131072, max_tokens=32768) == 0
        assert chapter_budget("", context_window=131072, max_tokens=32768) > MIN_CHAPTER_TOKENS


class TestSettingsPlumbing:
    """窗口要能从运营后台下发下来——否则调大 --max-model-len 之后还得改代码。"""

    def test_context_window_reaches_settings(self):
        from agent.models.gateway import model_override_to_settings

        out = model_override_to_settings({"params": {"max_tokens": 32768, "context_window": 262144}})
        assert out["model_context_window"] == 262144

    def test_window_not_bigger_than_output_is_rejected(self):
        """窗口 ≤ 输出配额是错配置，会算出负额度；按既有的"安全回退默认"语义丢弃。"""
        from agent.models.gateway import model_override_to_settings

        out = model_override_to_settings({"params": {"max_tokens": 32768, "context_window": 4096}})
        assert "model_context_window" not in out

    def test_absurd_window_rejected_even_without_max_tokens_in_the_same_payload(self):
        """只跟同一份 params 里的 max_tokens 比是不够的：这份没带时判据退化成 window > 0，
        4096 的窗口照样被采纳，而 settings 里可能还有一个 env 下发的 32768。"""
        from agent.models.gateway import model_override_to_settings

        out = model_override_to_settings({"params": {"context_window": 4096}})
        assert "model_context_window" not in out

    def test_node_reads_it_from_the_gateway(self):
        from types import SimpleNamespace

        from agent.agents.bidding_agent.nodes.common import chapters_budget

        ctx = SimpleNamespace(gateway=SimpleNamespace(
            s=SimpleNamespace(model_context_window=262144, model_max_tokens=32768)))
        wide = chapters_budget(ctx, "")
        ctx.gateway.s.model_context_window = 131072
        assert wide > chapters_budget(ctx, "")


class TestShrinkRetry:
    """估算永远会有偏差（换模型、换网关，字/token 的系数就变）。
    撞上超限时把预算打折重建，比把精度赌在估算上可靠。"""

    def _overflow(self):
        return Exception("Error code: 400 - {'error': {'message': \"This model's maximum "
                         "context length is 131072 tokens.\", 'code': 400}}")

    def test_recognises_the_real_400(self):
        assert is_context_overflow(self._overflow())

    def test_recognises_it_through_a_wrapper(self):
        """openai SDK 会把真因包一层，只看 str(顶层) 认不出来（本仓韧性铁律）。"""
        outer = RuntimeError("提交失败")
        outer.__cause__ = self._overflow()
        assert is_context_overflow(outer)

    def test_unrelated_failures_are_not_retried(self):
        assert not is_context_overflow(Exception("Connection error."))
        assert not is_context_overflow(Exception("401 Unauthorized"))

    def test_second_attempt_gets_a_smaller_budget(self):
        """**重点**：重试必须拿更小的预算重建载荷。
        原样重发同一条消息只是再烧一次钱，端点照样 400。"""
        seen = []

        async def build_and_run(factor):
            seen.append(factor)
            if len(seen) < 2:
                raise self._overflow()
            return "ok"

        assert asyncio.run(run_with_shrink(build_and_run)) == "ok"
        assert seen == [1.0, 0.5], f"重试用的折扣不对: {seen}"

    def test_gives_up_after_the_last_step_and_raises_the_real_error(self):
        """一直超限说明不是长度问题（或读标结论本身就撑爆了）——不能无限重试烧钱。"""
        calls = []

        async def always_overflow(factor):
            calls.append(factor)
            raise self._overflow()

        with pytest.raises(Exception, match="maximum context length"):
            asyncio.run(run_with_shrink(always_overflow))
        assert calls == [1.0, 0.5, 0.25]

    def test_other_errors_surface_immediately(self):
        """非长度问题不重试：多跑一轮既拖时间又烧钱，还掩盖真因。"""
        calls = []

        async def boom(factor):
            calls.append(factor)
            raise ValueError("模型未提交结构化结果")

        with pytest.raises(ValueError):
            asyncio.run(run_with_shrink(boom))
        assert calls == [1.0]
