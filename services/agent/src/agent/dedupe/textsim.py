from __future__ import annotations

import difflib
import re

# spec315b 查重文本维纯函数：分句 → 字符级 k-shingle Jaccard → difflib 摘录命中片段。
# 2-3 份小文档两两比对 O(n·m) 足够，架构定性纯算法（非 LLM、无需 LSH）。

_SENT_SPLIT = re.compile(r"[。！？；!?;\n]+")
_WS = re.compile(r"\s+")


def split_sentences(clauses: list[dict], min_len: int) -> list[str]:
    """条款文本 → 句子列表：按中文句读切分、去空白、过滤短句（编号/页眉类噪声）。"""
    out: list[str] = []
    for c in clauses:
        for raw in _SENT_SPLIT.split(c.get("text", "")):
            s = _WS.sub("", raw)
            if len(s) >= min_len:
                out.append(s)
    return out


def shingles(s: str, k: int) -> set[str]:
    """字符级 k-shingle 集合（中文无词边界，字符粒度即可）；短于 k 的句整句作一个 shingle。"""
    if len(s) < k:
        return {s} if s else set()
    return {s[i:i + k] for i in range(len(s) - k + 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    """Jaccard 相似度 |A∩B|/|A∪B|；任一为空返回 0。"""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def match_sentences(sents_a: list[str], sents_b: list[str], k: int,
                    threshold: float) -> tuple[float, list[tuple[int, int, float]]]:
    """两文档句子集两两比对，返回 (加权文本得分 0-100, 命中句对 [(ia, ib, sim)] 按 sim 降序)。
    得分口径：每句按「长度×最佳相似度」加权覆盖，双侧求和除以总长——
    两份几乎相同的文档趋近 100，无关文档趋近 0，可解释为「相似内容占比」。"""
    sh_a = [shingles(s, k) for s in sents_a]
    sh_b = [shingles(s, k) for s in sents_b]
    pairs: list[tuple[int, int, float]] = []
    best_b: dict[int, float] = {}
    covered_a = 0.0
    for i, sa in enumerate(sh_a):
        best, best_j = 0.0, -1
        for j, sb in enumerate(sh_b):
            sim = jaccard(sa, sb)
            if sim > best:
                best, best_j = sim, j
        if best >= threshold and best_j >= 0:
            pairs.append((i, best_j, best))
            covered_a += len(sents_a[i]) * best
            best_b[best_j] = max(best_b.get(best_j, 0.0), best)
    covered_b = sum(len(sents_b[j]) * s for j, s in best_b.items())
    total = sum(map(len, sents_a)) + sum(map(len, sents_b))
    score = 100.0 * (covered_a + covered_b) / total if total else 0.0
    pairs.sort(key=lambda p: p[2], reverse=True)
    return score, pairs


def longest_common_fragment(a: str, b: str) -> str:
    """difflib SequenceMatcher 摘录两句间最长公共片段，作为命中证据展示。"""
    m = difflib.SequenceMatcher(None, a, b).find_longest_match(0, len(a), 0, len(b))
    return a[m.a:m.a + m.size]


def strip_baseline(sents: list[str], baseline: list[str], k: int,
                   threshold: float) -> tuple[list[str], int]:
    """基线扣除：剔除与招标文件句高度相似的句（法定引用/固定格式条款不算抄）。
    返回 (剩余句子, 剔除数)。"""
    base_sh = [shingles(s, k) for s in baseline]
    kept: list[str] = []
    removed = 0
    for s in sents:
        sh = shingles(s, k)
        if any(jaccard(sh, b) >= threshold for b in base_sh):
            removed += 1
        else:
            kept.append(s)
    return kept, removed
