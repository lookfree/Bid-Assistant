import pytest
from agent.config import settings
from agent.framework import content_safety as cs


@pytest.fixture(autouse=True)
def _reset_cache():
    """load_words 是进程级 lru_cache 单例：每个用例前后清空，避免跨用例（含跨文件，比如
    export 节点测试）复用上一个用例打的 tmp 词库文件结果。"""
    cs.load_words.cache_clear()
    yield
    cs.load_words.cache_clear()


def _use_wordlist(tmp_path, monkeypatch, content: str):
    wordlist = tmp_path / "words.txt"
    wordlist.write_text(content, encoding="utf-8")
    monkeypatch.setattr(settings, "sensitive_words_path", str(wordlist))
    cs.load_words.cache_clear()


def test_load_words_skips_comments_and_blank_lines(tmp_path, monkeypatch):
    _use_wordlist(tmp_path, monkeypatch, "# 注释\n\n赌博\n色情\n")
    assert cs.load_words() == frozenset({"赌博", "色情"})


def test_scan_text_counts_hits_and_lowercases_english(tmp_path, monkeypatch):
    _use_wordlist(tmp_path, monkeypatch, "赌博\nCasino\n")
    hits = cs.scan_text("这是一个赌博网站，赌博害人。也有 CASINO 广告。")
    assert hits == {"赌博": 2, "casino": 1}


def test_scan_text_no_hit_returns_empty_dict(tmp_path, monkeypatch):
    _use_wordlist(tmp_path, monkeypatch, "赌博\n")
    assert cs.scan_text("完全正常的招标文件内容，技术方案与商务报价。") == {}


def test_load_words_uses_default_bundled_file_when_path_unset(monkeypatch):
    """settings.sensitive_words_path 为 None（默认）→ 用包内 sensitive_words.txt，命中真实词库。"""
    monkeypatch.setattr(settings, "sensitive_words_path", None)
    cs.load_words.cache_clear()
    words = cs.load_words()
    assert "赌博" in words
    assert "毒品" in words


# ---------------------------------------------------------------- 钩子形态
# extra_hooks 这个扩展点留了半年零使用者。敏感词扫描是它的第一个真实使用者——
# 当初绕开它硬接进 export 节点，根本原因是框架没有否决信号（见 hooks.py）。

class _FakeRecorder:
    def __init__(self):
        self.events = []

    def log_event(self, run_id, agent_type, event_type, **kw):
        self.events.append((event_type, kw))


class _FakeRunCtx:
    def __init__(self):
        self.run_id, self.agent_type, self.thread_id = "r1", "bidding", "t1"
        self.recorder = _FakeRecorder()


class _FakeLLM:
    def __init__(self, content):
        self.content = content

    async def ainvoke(self, messages):
        from langchain_core.messages import AIMessage
        return AIMessage(content=self.content)


async def _run(hook, text):
    from agent.framework.hooks import run_turn
    return await run_turn([hook], _FakeLLM(text), {"messages": []}, None)


async def test_hook_flag_mode_records_but_passes_through(tmp_path, monkeypatch):
    """默认口径：只识别记录，照常放行。与 export 节点上跑了半年的那份一致。"""
    _use_wordlist(tmp_path, monkeypatch, "赌博\n")
    rc = _FakeRunCtx()
    ctx = await _run(cs.ContentSafetyHook(rc), "这里提到赌博二字")
    assert ctx.denied is False
    assert ctx.result.content == "这里提到赌博二字"          # 原文放行
    assert rc.recorder.events[0][0] == "content_flag"
    assert rc.recorder.events[0][1]["data"]["blocked"] is False


async def test_hook_block_mode_denies_the_turn(tmp_path, monkeypatch):
    """block 模式：命中即掐掉输出。框架有否决信号之后才可能有这个模式。"""
    _use_wordlist(tmp_path, monkeypatch, "赌博\n")
    rc = _FakeRunCtx()
    ctx = await _run(cs.ContentSafetyHook(rc, block=True), "这里提到赌博二字")
    assert ctx.denied is True
    assert ctx.result.content == cs.DENY_MESSAGE
    assert ctx.denied_by == "ContentSafetyHook"
    assert rc.recorder.events[0][1]["data"]["blocked"] is True


async def test_hook_no_hit_is_silent(tmp_path, monkeypatch):
    _use_wordlist(tmp_path, monkeypatch, "赌博\n")
    rc = _FakeRunCtx()
    ctx = await _run(cs.ContentSafetyHook(rc, block=True), "正常的技术方案与商务报价")
    assert ctx.denied is False and rc.recorder.events == []


async def test_hook_skips_tool_call_turns(tmp_path, monkeypatch):
    """工具调用轮 content 是空串，不该走扫描。"""
    _use_wordlist(tmp_path, monkeypatch, "赌博\n")
    rc = _FakeRunCtx()
    ctx = await _run(cs.ContentSafetyHook(rc, block=True), "")
    assert ctx.denied is False and rc.recorder.events == []


def test_failure_policy_follows_mode():
    """只记录的时候扫描挂了无所谓，一旦变成拦截器，扫描挂了必须让整轮失败——
    否则扫描器一崩，拦截静默消失，配置里还写着「已开启拦截」。"""
    from agent.framework.hooks import FAIL, IGNORE
    assert cs.ContentSafetyHook(None).failure_policy == IGNORE
    assert cs.ContentSafetyHook(None, block=True).failure_policy == FAIL


async def test_recorder_failure_never_breaks_the_turn(tmp_path, monkeypatch):
    """埋点写失败不算扫描失败：拦截模式下也不该因为 PG 断连就整轮报错。"""
    _use_wordlist(tmp_path, monkeypatch, "赌博\n")
    rc = _FakeRunCtx()
    rc.recorder.log_event = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("PG 断了"))
    ctx = await _run(cs.ContentSafetyHook(rc, block=True), "这里提到赌博二字")
    assert ctx.denied is True                              # 拦截照常生效
    assert ctx.result.content == cs.DENY_MESSAGE
