"""篇幅守卫（2026-08-09 生产实测缺陷）：用户选 5.1 万字/99 页，实际只拿到 48%。

230 遥测把 0.48 拆成了两个独立的乘数，这里各守一条：
  · ÷1.4 的超写校准是**旧引擎旧提示词**的产物，新流水线提示词已写死「上限 +10%」，
    超写不复存在——校准回归 1.0（`test_content_helpers.py` 里的预算口径断言同步改）；
  · 【篇幅】行只有上限没有下限，配上「宁可略欠」，写手实测 produced/work=0.675。
    改成双边带。

助手（_FakeChat/_run/…）复用 test_content_pipeline 的那套，不抄第二份。
"""
from .test_content_pipeline import _FakeChat, _brief_of, _run, _state


def _state_with_target(n=1, target=20000):
    """带篇幅目标的最小状态：单技术章时 work=target、该章预算=target（校准 1.0 后的口径）。"""
    state = _state(n)
    state["run_input"] = {"target_chars": target}
    return state


def _length_line(chat, title="章节1") -> str:
    return next(p for p in _brief_of(chat, title).split("\n\n") if p.startswith("【篇幅】"))


class TestLengthBand:
    """【篇幅】行必须是双边带：只给上限 +「宁可略欠」= 实测欠三成的直接来源。"""

    def test_length_line_states_a_floor_not_a_licence_to_underdeliver(self, monkeypatch):
        chat = _FakeChat()
        _run(_state_with_target(), chat, monkeypatch=monkeypatch)
        line = _length_line(chat)
        assert "90%" in line, "篇幅行只有上限没有下限——写手照旧欠三成"
        assert "宁可略欠" not in line, "「宁可略欠」正是 produced/work=0.675 的措辞来源"
        assert "本章目标约" in line and "全书目标约" in line, "既有口径（按章/全书目标）不能丢"
        assert "注水" in line, "补足篇幅的手段必须限定为实质内容，否则换来一堆套话"
