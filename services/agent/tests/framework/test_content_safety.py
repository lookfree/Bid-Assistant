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
