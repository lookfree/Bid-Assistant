from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations

from agent.dedupe.textsim import longest_common_fragment, match_sentences
from agent.parsing.media import hamming

# spec315b 查重引擎：text 为主分（句级相似度加权），image/meta 命中作加分项，
# tone 阈值按 strategy 平移（standard: ≥70 destructive / ≥40 warning）。

STRATEGIES = {
    #                k 越小 shingle 越敏感；sent_th 为句对命中的 Jaccard 门槛
    "fast":     {"k": 8, "sent_th": 0.50, "destructive": 80, "warning": 50},
    "standard": {"k": 5, "sent_th": 0.50, "destructive": 70, "warning": 40},
    "strict":   {"k": 3, "sent_th": 0.45, "destructive": 60, "warning": 30},
}
BASELINE_TH = 0.60        # 与招标文件句相似度 ≥ 此值 → 视为法定引用剔除
HAMMING_TH = 6            # dHash 汉明距离 ≤6 记图片命中（spec 契约）
MAX_TEXT_HITS = 5         # 每对最多摘录的高相似句对数（证据展示，非全量）
IMAGE_BONUS, IMAGE_BONUS_CAP = 6, 18
META_BONUS, META_BONUS_CAP = 8, 16
_META_FIELDS = {"author": "作者", "company": "公司", "last_modified_by": "最后修改者"}
_TONE_LEAD = {"destructive": "高度疑似围标/串标", "warning": "存在一定相似风险",
              "success": "未见明显围标特征"}


@dataclass
class DocFeatures:
    """单份投标文件参与比对的全部特征（路由层解析/抽取后灌入，引擎不做 IO）。"""
    label: str
    sentences: list[str] = field(default_factory=list)
    image_hashes: list[int] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    baseline_removed: int = 0    # 基线扣除掉的句数（仅用于 note 解释）


def _text_hits(sents_a: list[str], sents_b: list[str],
               pairs: list[tuple[int, int, float]]) -> list[dict]:
    """高分句对 → 命中证据：全句摘录 + difflib 最长公共片段。"""
    hits = []
    for i, j, sim in pairs[:MAX_TEXT_HITS]:
        frag = longest_common_fragment(sents_a[i], sents_b[j])
        hits.append({"dim": "text", "a_text": sents_a[i][:120], "b_text": sents_b[j][:120],
                     "detail": f"句级相似度 {sim:.0%}，最长公共片段：「{frag[:60]}」"})
    return hits


def _image_hits(hashes_a: list[int], hashes_b: list[int]) -> list[dict]:
    """dHash 汉明近邻命中：A 侧每张图最多记一次（防同图多配对刷分）。"""
    hits = []
    for x in hashes_a:
        for y in hashes_b:
            d = hamming(x, y)
            if d <= HAMMING_TH:
                hits.append({"dim": "image",
                             "detail": f"两文件存在指纹近似图片（dHash 汉明距离 {d}）"})
                break
    return hits


def _meta_hits(meta_a: dict, meta_b: dict) -> list[dict]:
    """文档属性命中：author/company/last_modified_by 非空且相等才算。"""
    hits = []
    for key, label in _META_FIELDS.items():
        va = (meta_a.get(key) or "").strip()
        vb = (meta_b.get(key) or "").strip()
        if va and va == vb:
            hits.append({"dim": "meta", "detail": f"文档属性「{label}」相同：{va}"})
    return hits


def compare_pair(a: DocFeatures, b: DocFeatures, dims: list[str], strategy: str) -> dict:
    """两份文件比对 → spec 契约 pair 形状 {a,b,score,tone,note,hits}。
    score 合成：text 得分为主，image/meta 命中按封顶加分；note 给出可解释中文说明。"""
    cfg = STRATEGIES[strategy]
    hits: list[dict] = []
    notes: list[str] = []
    score = 0.0
    if "text" in dims:
        text_score, pairs = match_sentences(a.sentences, b.sentences, cfg["k"], cfg["sent_th"])
        hits += _text_hits(a.sentences, b.sentences, pairs)
        score += text_score
        notes.append(f"文本相似度约 {text_score:.0f}%（{len(pairs)} 组高相似句对）")
    if "image" in dims:
        ih = _image_hits(a.image_hashes, b.image_hashes)
        if ih:
            hits += ih
            score += min(len(ih) * IMAGE_BONUS, IMAGE_BONUS_CAP)
            notes.append(f"图片指纹命中 {len(ih)} 处")
    if "meta" in dims:
        mh = _meta_hits(a.meta, b.meta)
        if mh:
            hits += mh
            score += min(len(mh) * META_BONUS, META_BONUS_CAP)
            notes.append("、".join(h["detail"] for h in mh))
    if removed := a.baseline_removed + b.baseline_removed:
        notes.append(f"已剔除与招标文件高度相似的 {removed} 句（法定引用不计入）")
    final = min(100, round(score))
    tone = ("destructive" if final >= cfg["destructive"]
            else "warning" if final >= cfg["warning"] else "success")
    note = f"{_TONE_LEAD[tone]}：{'；'.join(notes)}" if notes else _TONE_LEAD[tone]
    return {"a": a.label, "b": b.label, "score": final, "tone": tone, "note": note, "hits": hits}


def run_dedupe(docs: list[DocFeatures], dims: list[str], strategy: str) -> dict:
    """全部两两比对（2 份 1 对 / 3 份 3 对）→ {pairs, overall}。
    baseline 剔除由路由层在灌 DocFeatures 前完成，引擎只看剩余句子。"""
    cfg = STRATEGIES[strategy]
    pairs = [compare_pair(a, b, dims, strategy) for a, b in combinations(docs, 2)]
    max_score = max((p["score"] for p in pairs), default=0)
    high = sum(1 for p in pairs if p["score"] >= cfg["destructive"])
    return {"pairs": pairs, "overall": {"max_score": max_score, "high_pairs": high}}
