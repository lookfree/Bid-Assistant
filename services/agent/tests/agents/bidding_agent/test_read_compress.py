"""读标结论压缩：条目太多时，先压结论本身，而不是只截正文。

2026-08-08 全库实测：最大的一份读标结论 210311 tokens（2747 个条目），单它一个就是
131072 窗口的两倍——这种项目无论怎么截正文都进不去，正文一个字都放不下。
"""
import json

from agent.agents.bidding_agent.nodes.common import compress_read
from agent.framework.budget import estimate_tokens


def _read(n_plain: int, n_star: int = 2, value_len: int = 200) -> dict:
    items = [{"title": f"普通要求{i}", "value": "详" * value_len, "status": "found",
              "risk": False, "star": False, "clause_ids": [f"sec-{i}-c1", f"sec-{i}-c2"]}
             for i in range(n_plain)]
    items += [{"title": f"★不可偏离{i}", "value": "关键" * 20, "status": "found",
               "risk": False, "star": True, "clause_ids": [f"sec-9{i}-c1"]} for i in range(n_star)]
    items += [{"title": "废标红线", "value": "缺该证即废标", "status": "missing",
               "risk": True, "star": False, "clause_ids": ["sec-1-c1"]}]
    return {"project_meta": {}, "categories": [{"key": "qualification", "title": "资格", "items": items}],
            "scoring": [], "risk_summary": []}


def _tok(d: dict) -> int:
    return estimate_tokens(json.dumps(d, ensure_ascii=False))


class TestCompress:
    def test_fits_the_budget(self):
        out = compress_read(_read(2000), 20_000)
        assert _tok(out) <= 10_000, f"压完仍有 {_tok(out)} tokens"

    def test_star_and_risk_items_always_survive(self):
        """★条款漏一条就是废标，普通条目模型还能从正文里看到——任何一级降级都不动它们。"""
        out = compress_read(_read(3000, n_star=2), 20_000)
        items = out["categories"][0]["items"]
        assert sum(1 for i in items if i.get("star")) == 2
        assert sum(1 for i in items if i.get("risk")) == 1
        assert all(i["value"] for i in items if i.get("star") or i.get("risk")), "★条款的取值被截了"

    def test_small_read_is_untouched_apart_from_ids(self):
        """放得下就别压——压缩是有损的，不该无差别执行。"""
        src = _read(3, value_len=10)
        out = compress_read(src, 100_000)
        assert len(out["categories"][0]["items"]) == len(src["categories"][0]["items"])
        assert all(i["value"] == s["value"] for i, s in
                   zip(out["categories"][0]["items"], src["categories"][0]["items"]))

    def test_clause_ids_never_reach_the_model(self):
        """条款 id 占 10% 的量，审查/述标的产出又用不到它——而它正是模型把内部编号
        抄进用户可见文字的源头（全库实测四处泄露）。从源头不给。"""
        out = compress_read(_read(5, value_len=10), 100_000)
        assert "clause_ids" not in json.dumps(out, ensure_ascii=False)

    def test_degrades_gradually_not_all_at_once(self):
        """预算越紧压得越狠，但不能一步跳到只剩★——中间几级还留着普通条目的标题。"""
        loose = compress_read(_read(400), 200_000)
        tight = compress_read(_read(400), 20_000)
        assert len(loose["categories"][0]["items"]) >= len(tight["categories"][0]["items"])
        assert _tok(loose) > _tok(tight)
