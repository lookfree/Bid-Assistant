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


class TestReviewFindings:
    """代码审查（2026-08-08）挑出的三处，都能在真实流程里踩到。"""

    def test_many_sections_still_respect_the_budget(self):
        """章一多，单章保底就让总量形同虚设——收缩重试三轮发同一条消息，白烧两轮还是 400。

        线下标书每个标题解析成一节，90 多节是常态，这条路一点都不偏门。
        """
        from agent.agents.bidding_agent.nodes.common import allocate_chapter_budget

        texts = {f"sec-{i}": "内容" * 3000 for i in range(150)}
        sizes = [sum(len(v) for v in allocate_chapter_budget(texts, int(40_000 * f), 1_000).values())
                 for f in (1.0, 0.5, 0.25)]
        assert all(s <= b * 1.1 for s, b in zip(sizes, (40_000, 20_000, 10_000))), sizes
        assert sizes[0] > sizes[1] > sizes[2], f"收缩没起作用，三轮一样大: {sizes}"

    def test_scoring_rows_lose_their_clause_ids_too(self):
        """评分行同样带 clause_ids——只清条目不清它，编号照样进模型。"""
        read = {"project_meta": {}, "categories": [], "risk_summary": [],
                "scoring": [{"id": "s1", "category": "技术", "name": "方案完整性",
                             "clause_ids": ["sec-2-c8"]}]}
        assert "sec-2-c8" not in json.dumps(compress_read(read, 100_000), ensure_ascii=False)

    def test_industry_patches_match_the_uncompressed_read(self, submit_gateway):
        """资质术语藏在条目取值里，压缩会截短甚至丢掉它们——恰恰是需要压缩的大标书，
        行业必查项会静默失效（漏一条即废标）。审查必须拿未压缩的读标去匹配。"""
        import asyncio

        from agent.agents.bidding_agent.nodes.review import make_review_node
        from agent.runtime.registry import RunContext

        read = {"categories": [{"key": "qualification", "title": "资格", "items": (
            [{"title": f"普通{i}", "value": "详" * 300, "risk": False, "star": False}
             for i in range(400)]
            # 关键词必须落在**截断线之后**，才测得出"匹配用了压缩后的读标"这个错误：
            # 压缩把普通条目的取值截到 60 字，前 60 字里的词无论如何都还在。
            + [{"title": "服务范围", "value": "详" * 120 + "本项目含劳务派遣用工",
                "risk": False, "star": False}])}],
            "scoring": [], "risk_summary": [], "project_meta": {}}
        gw = submit_gateway({"submit_risk_report": {
            "score": 80, "items": [], "passed_items": []}})
        ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)
        asyncio.run(make_review_node(ctx)(
            {"read": read, "outline": {}, "chapters": {"b1": "<p>正文</p>"}}))
        user = gw.chats[-1].last_messages[1].content
        assert "劳务派遣经营许可证" in user, "资质补丁匹配用了压缩后的读标，行业必查项静默失效"
