"""篇幅守卫（2026-08-09 生产实测缺陷）：用户选 5.1 万字/99 页，实际只拿到 48%。

230 遥测把 0.48 拆成了两个独立的乘数，这里各守一条：
  · ÷1.4 的超写校准是**旧引擎旧提示词**的产物，新流水线提示词已写死「上限 +10%」，
    超写不复存在——校准回归 1.0（`test_content_helpers.py` 里的预算口径断言同步改）；
  · 【篇幅】行只有上限没有下限，配上「宁可略欠」，写手实测 produced/work=0.675。
    改成双边带 + 短章写完追一轮扩写兜底。

扩写的铁律是**不丢内容**：失败/被截断/仍偏短，一律取两稿中较长者，绝不因为追了一轮
反而交付得更少。

助手（_FakeChat/_FakeRedis/_run/…）复用 test_content_pipeline 的那套，不抄第二份。
"""
from langchain_core.messages import AIMessage

from agent.agents.bidding_agent.nodes.content import _visible_len

from .test_content_pipeline import _FakeChat, _FakeRedis, _brief_of, _run, _state

# 扩写轮 user 消息里的稳定标记：测试据此区分「首稿轮」与「扩写轮」，也用来断言
# 无预算/小预算/缓存命中的章根本没发出扩写调用。
_EXPAND_MARK = "本章已完成的初稿"


def _state_with_target(n=1, target=20000):
    """带篇幅目标的最小状态：单技术章时 work=target、该章预算=target（校准 1.0 后的口径）。"""
    state = _state(n)
    state["run_input"] = {"target_chars": target}
    return state


def _length_line(chat, title="章节1") -> str:
    return next(p for p in _brief_of(chat, title).split("\n\n") if p.startswith("【篇幅】"))


class _ExpandChat:
    """首稿 first 个字符、扩写稿 second 个字符；boom=True 让扩写轮直接抛错。

    首稿/扩写稿用不同填充字（甲/乙），断言终稿到底取的是哪一份时不会混。"""

    def __init__(self, first: int, second: int = 0, boom: bool = False):
        self.first, self.second, self.boom = first, second, boom
        self.calls = 0
        self.seen: list[str] = []

    async def ainvoke(self, msgs, config=None):
        self.calls += 1
        user = msgs[-1].content
        self.seen.append(user)
        if _EXPAND_MARK in user:
            if self.boom:
                raise RuntimeError("端点抖动")
            return AIMessage(content=f"<h3>一、正文</h3><p>{'乙' * self.second}</p>")
        return AIMessage(content=f"<h3>一、正文</h3><p>{'甲' * self.first}</p>")


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


class TestShortChapterExpansion:
    """短章补写兜底：fresh 章写完后明显短于本章预算 → 追**一轮**扩写。"""

    def test_short_first_draft_gets_exactly_one_expansion_round(self, monkeypatch):
        """恰好两次调用（首稿 + 一轮扩写），终稿是扩写稿，**缓存里存的也是扩写稿**——
        存首稿的话，下次续跑命中缓存就再也扩不动了，短章被永久钉死。"""
        redis = _FakeRedis()
        chat = _ExpandChat(first=10000, second=19000)
        out = _run(_state_with_target(), chat, redis=redis, monkeypatch=monkeypatch)
        assert chat.calls == 2, f"扩写没触发或不止一轮（实际 {chat.calls} 次调用）"
        assert "20000" in chat.seen[1] and "10004" in chat.seen[1], "扩写轮没告知目标字数/现有字数"
        assert _visible_len(out["t1"]) == 19004, "终稿不是扩写稿"
        cached = [v for v in redis.kv.values() if v]
        assert cached and _visible_len(cached[0]) == 19004, "缓存里存的是首稿——续跑还得再扩一次"

    def test_expansion_that_stays_short_never_shrinks_the_chapter(self, monkeypatch):
        """扩写稿仍偏短 → 取两稿中较长者（这里是首稿）。追一轮绝不能让本章变得更少。"""
        chat = _ExpandChat(first=10000, second=5000)
        out = _run(_state_with_target(), chat, monkeypatch=monkeypatch)
        assert chat.calls == 2
        assert _visible_len(out["t1"]) == 10004, "扩写稿更短却被采用了——追一轮反而丢内容"

    def test_expansion_failure_keeps_the_first_draft(self, monkeypatch):
        """扩写调用抛错只 warning，本章照常按首稿交付（与 _retry_missing 同风格，失败不抛）。"""
        chat = _ExpandChat(first=10000, boom=True)
        out = _run(_state_with_target(), chat, monkeypatch=monkeypatch)
        assert chat.calls == 2 and _visible_len(out["t1"]) == 10004

    def test_cached_chapter_never_triggers_expansion(self, monkeypatch):
        """缓存命中章是既成事实：0 次调用，不因为它短就再烧一轮钱。"""
        redis = _FakeRedis()
        first_run = _ExpandChat(first=10000, second=10000)      # 扩写不比首稿长 → 缓存里落的是短首稿
        _run(_state_with_target(), first_run, redis=redis, monkeypatch=monkeypatch)
        resumed = _ExpandChat(first=10000, second=19000)
        out = _run(_state_with_target(), resumed, redis=redis, monkeypatch=monkeypatch)
        assert resumed.calls == 0, "缓存命中的章又被扩写了一遍"
        assert _visible_len(out["t1"]) == 10004

    def test_small_budget_chapter_is_left_alone(self, monkeypatch):
        """预算 <1500 字的小章不触发：几百字的章来回抖一轮，纯烧钱。"""
        chat = _ExpandChat(first=200, second=1200)
        out = _run(_state_with_target(target=1200), chat, monkeypatch=monkeypatch)
        assert chat.calls == 1, "小预算章也被扩写了"
        assert _visible_len(out["t1"]) == 204

    def test_a_truncated_chapter_is_not_expanded(self, monkeypatch):
        """截断过的章不追扩写：刚让它「压缩篇幅、确保完整收尾」，转头再让它扩写是自相矛盾，
        而扩写是**整章替换**，再撞一次上限等于把成稿换成半章。不丢内容优先。"""

        class _TruncThenShort(_ExpandChat):
            async def ainvoke(self, msgs, config=None):
                out = await super().ainvoke(msgs, config)
                if self.calls == 1:
                    out.response_metadata = {"finish_reason": "length"}
                return out

        chat = _TruncThenShort(first=10000, second=19000)
        _run(_state_with_target(), chat, monkeypatch=monkeypatch)
        assert chat.calls == 2, "截断重试之后又追了一轮扩写"
        assert all(_EXPAND_MARK not in u for u in chat.seen)


def test_no_target_chars_leaves_everything_exactly_as_before(monkeypatch):
    """用户没选篇幅（无 target_chars）→ 无预算 → 简报无【篇幅】段、一章一次调用、零扩写。"""
    chat = _FakeChat()
    out = _run(_state(3), chat, monkeypatch=monkeypatch)
    assert chat.calls == 3 and len(out) == 3
    assert all("【篇幅】" not in u and _EXPAND_MARK not in u for _, u in chat.seen)


class _GrowChat:
    """按轮次给不同长度的稿：seq[i] 是第 i 轮扩写稿的可见字数（首稿用 first）。
    稿子做成**三个小节**——真实章节都是多节，单节稿走不到逐节配额那条路。"""

    def __init__(self, first: int, seq: list[int]):
        self.first, self.seq = first, seq
        self.expand_rounds = 0
        self.seen: list[str] = []

    @staticmethod
    def _draft(total: int, fill: str) -> str:
        per = total // 3
        return "".join(f"<h3>{t}</h3><p>{fill * per}</p>"
                       for t in ("一、项目理解", "二、技术方案", "三、实施计划"))

    async def ainvoke(self, msgs, config=None):
        user = msgs[-1].content
        self.seen.append(user)
        if _EXPAND_MARK in user:
            n = self.seq[min(self.expand_rounds, len(self.seq) - 1)]
            self.expand_rounds += 1
            return AIMessage(content=self._draft(n, "乙"))
        return AIMessage(content=self._draft(self.first, "甲"))


class TestMultiRoundExpansion:
    """2026-08-16 生产实测（4.1 万目标只出 2.4 万）：扩写**只跑一轮且不校验结果**——
    t2/t4/t6 扩写后到 90%+，t3 只涨 16 字、t5 涨 287、b6 涨 201，三章停在 33%~62%
    就没人再管了。扩写必须多轮直到达标；模型吐不动了才收手。"""

    def test_expansion_keeps_going_until_the_floor_is_met(self, monkeypatch):
        chat = _GrowChat(first=4000, seq=[8000, 12000, 19000])
        out = _run(_state_with_target(target=20000), chat, monkeypatch=monkeypatch)
        assert chat.expand_rounds >= 3, f"扩写只跑了 {chat.expand_rounds} 轮就收工"
        from agent.agents.bidding_agent.nodes.content import _visible_len
        assert _visible_len(out["t1"]) >= 20000 * 0.9, "多轮扩写后仍未达标"

    def test_expansion_stops_when_the_model_stops_growing(self, monkeypatch):
        """t3 形态：模型原样退回（+16 字）。再烧同样的轮次纯属浪费——涨不动就收手。"""
        chat = _GrowChat(first=4000, seq=[4016, 4020, 4022, 4024])
        _run(_state_with_target(target=20000), chat, monkeypatch=monkeypatch)
        assert chat.expand_rounds <= 2, f"模型已经吐不动了还跑了 {chat.expand_rounds} 轮"

    def test_second_round_gives_per_section_quotas(self, monkeypatch):
        """「整章再多写 4000 字」模型会原样退回；「这几个小节各自至少写到 N 字」才动得起来。"""
        chat = _GrowChat(first=4000, seq=[4100, 12000, 19000])
        _run(_state_with_target(target=20000), chat, monkeypatch=monkeypatch)
        rounds = [u for u in chat.seen if _EXPAND_MARK in u]
        assert len(rounds) >= 2
        assert "每个小节" in rounds[1] or "逐节" in rounds[1], "第二轮没给逐节配额，还是整章级指令"
