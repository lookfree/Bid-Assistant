"""输出内容敏感词扫描：备案「违法不良信息识别与发现机制」的机器侧。只识别记录，不拦截不改文。"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from agent.config import settings


@lru_cache(maxsize=1)
def load_words() -> frozenset[str]:
    """词库：settings.sensitive_words_path 优先，否则包内默认文件。每行一词，# 注释与空行跳过。"""
    path = (Path(settings.sensitive_words_path) if settings.sensitive_words_path
            else Path(__file__).parent / "sensitive_words.txt")
    words = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        w = line.strip()
        if w and not w.startswith("#"):
            words.add(w.lower())
    return frozenset(words)


def scan_text(text: str) -> dict[str, int]:
    """子串计数扫描（词库百量级，直扫够用）。英文词忽略大小写。返回 {词: 次数}，无命中空 dict。"""
    lowered = text.lower()
    hits = {word: count for word in load_words() if (count := lowered.count(word)) > 0}
    return hits
