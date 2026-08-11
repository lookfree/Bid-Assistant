"""证照定向插章 post-pass（2026-08-09 资料库定向注入设计,计划③,Task 4）：招标要求命中
证照词表 × 章定位（clause_ids 交集）× 资料库库存三重命中——库有则见下图插占位图,库无则
待补充,定位不到则不动;缓存交互（post-pass 在缓存之外单独跑,fresh/cached 章一律现算）与
sys-creds 排除是本文件的审查专项。
"""
import asyncio

from langchain_core.messages import AIMessage

from agent.agents.bidding_agent.nodes.cert_placement import CERT_KEYWORDS, place_certificates
from agent.agents.bidding_agent.nodes.credentials_chapter import SYS_CREDS_ID


def _chapter(cid: str, title: str, clause_ids: list[str]) -> dict:
    return {"id": cid, "no": "一", "title": title, "group": "business",
            "items": [{"id": f"{cid}-i1", "label": "资质要求", "clause_ids": clause_ids}]}


def _read_with(item_title: str, clause_ids: list[str], key: str = "qualification") -> dict:
    return {"categories": [{"key": key, "title": "资格", "items": [
        {"title": item_title, "value": "", "star": True, "clause_ids": clause_ids}]}]}


class TestPlaceCertificates:
    def test_located_chapter_with_library_stock_appends_see_image_with_ocr_alt(self):
        """①要求"提供营业执照"定位到资格章 + 库有"营业执照"条目 → 该章尾出现见下图 +
        占位图(alt 带 ocr 摘要,截 120 字并转义),其他章不动。"""
        out = {"t1": "<h3>正文</h3>", "t2": "<h3>别的章</h3>"}
        # ocr 前段含需转义字符,后段用不重复的填充字符验证 120 字截断（TAILMARK 必须被切掉）。
        ocr_text = "<script>bad</script>" + "A" * 99 + "TAILMARK"
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"]),
                                     _chapter("t2", "技术方案", ["sec-2-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [
                {"title": "营业执照", "images": [
                    {"fileId": "f1", "key": "lib/f1.png", "name": "n", "ocrText": ocr_text}]}]},
        }
        result = place_certificates(out, state)
        assert "【营业执照】见下图：" in result["t1"]
        assert 'data-file-id="f1"' in result["t1"] and 'data-object-key="lib/f1.png"' in result["t1"]
        assert "&lt;script&gt;bad&lt;/script&gt;" in result["t1"], "ocr 摘要未转义"
        assert "<script>bad</script>" not in result["t1"], "原始未转义标签泄漏进 HTML"
        assert "A" * 99 in result["t1"]
        assert "TAILMARK" not in result["t1"], "ocr 摘要没有按 120 字截断"
        assert result["t2"] == out["t2"], "无关章不该被动"

    def test_missing_from_library_appends_placeholder_note(self):
        """②库无匹配条目 → 章尾追加"（待补充：营业执照）"，不出现见下图字样。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": []},
        }
        result = place_certificates(out, state)
        assert "（待补充：营业执照）" in result["t1"]
        assert "见下图" not in result["t1"]

    def test_no_clause_intersection_leaves_chapter_untouched(self):
        """③要求条目 clause_ids 与本章子项 clause_ids 无交集 → 定位不到,章原样不动。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-9-c9"]),   # 与本章无交集
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result = place_certificates(out, state)
        assert result["t1"] == out["t1"]

    def test_no_keyword_hit_leaves_chapter_untouched(self):
        """词表不命中（要求条目标题不含任何证照词）→ 即便 clause 相交也不动,附录/程序性章节
        天然兜底,不会被误插一句无中生有的证照提示。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供项目实施方案", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result = place_certificates(out, state)
        assert result["t1"] == out["t1"]

    def test_sys_creds_chapter_is_never_touched(self):
        """⑤sys-creds 章不被 post-pass 触碰——双信号防御：即使满足三重命中条件也绝不追加
        （纵深兜底同 content_pipeline 净化系统章的手法：system 标记 与 id==SYS_CREDS_ID 各自
        独立生效，即便某一路信号丢了另一路仍能挡住）。"""
        out = {SYS_CREDS_ID: "<h3>附录</h3>"}
        state = {
            "outline": {"chapters": [
                {**_chapter(SYS_CREDS_ID, "资格证明文件", ["sec-1-c1"]), "system": True}]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result = place_certificates(out, state)
        assert result[SYS_CREDS_ID] == out[SYS_CREDS_ID]

        # 纵深兜底：system 键缺省（坏数据/漏透传），仅凭 id 命中 SYS_CREDS_ID 仍要挡住。
        state_no_flag = {
            "outline": {"chapters": [_chapter(SYS_CREDS_ID, "资格证明文件", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        result2 = place_certificates(out, state_no_flag)
        assert result2[SYS_CREDS_ID] == out[SYS_CREDS_ID]

    def test_same_chapter_two_requirements_same_keyword_insert_once(self):
        """⑥同章两条要求都命中同一个证照词 → 只插一次,不重复见下图两遍。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1", "sec-1-c2"])]},
            "read": {"categories": [{"key": "qualification", "title": "资格", "items": [
                {"title": "提供营业执照复印件", "value": "", "star": True, "clause_ids": ["sec-1-c1"]},
                {"title": "加盖公章的营业执照", "value": "", "star": False, "clause_ids": ["sec-1-c2"]},
            ]}]},
            "run_input": {"credentials": [
                {"title": "营业执照", "images": [{"fileId": "f1", "key": "k1", "name": "n"}]}]},
        }
        result = place_certificates(out, state)
        assert result["t1"].count("【营业执照】见下图：") == 1

    def test_word_list_matches_global_constraints_literal(self):
        """词表字面量必须与 web 侧 lib/cert-keywords.ts 逐字同形（双端同表约定的锚点）。
        2026-08-11 扩入财务与资格类材料——康恒那单实测报「近三年经审计的资产负债表未提供」，
        而文件就在资料库「财务材料」分类里，此前词表只覆盖资质类，插不进去。"""
        assert CERT_KEYWORDS == ("营业执照", "资质证书", "授权书", "法定代表人身份证明",
                                 "检测证书", "许可证",
                                 "审计报告", "资产负债表", "利润表", "财务报表", "纳税证明",
                                 "完税证明", "社保证明", "银行资信证明", "开户许可证")

    def test_financial_requirement_inserts_the_financial_document(self):
        """招标要求「近三年经审计的资产负债表」→ 资料库里那条（财务分类的条目同样进 credentials）
        被插到定位到的章里。此前这类要求一个词都不命中，材料躺在库里也进不了标书。"""
        out = {"t1": "<h3>资格证明</h3>"}
        state = {"outline": {"chapters": [_chapter("t1", "资格证明文件", ["sec-4-c1"])]},
                 "read": _read_with("近三年经审计的资产负债表、损益表", ["sec-4-c1"]),
                 "run_input": {"credentials": [
                     {"title": "2025年度资产负债表", "images": [
                         {"fileId": "f9", "key": "k9", "name": "bs.png", "ocrText": "资产总计"}]}]}}
        result = place_certificates(out, state)
        assert "【资产负债表】见下图：" in result["t1"]
        assert 'data-file-id="f9"' in result["t1"]

    def test_a_more_specific_keyword_wins_over_the_one_it_contains(self):
        """词表存在包含关系（「开户许可证」⊃「许可证」）：两个都命中就会为同一份材料插两遍图。
        只留更具体的那个。"""
        out = {"t1": "<h3>资格证明</h3>"}
        state = {"outline": {"chapters": [_chapter("t1", "资格证明文件", ["sec-4-c1"])]},
                 "read": _read_with("基本账户开户许可证", ["sec-4-c1"]),
                 "run_input": {"credentials": [
                     {"title": "开户许可证", "images": [
                         {"fileId": "f8", "key": "k8", "name": "acc.png"}]}]}}
        result = place_certificates(out, state)
        assert result["t1"].count("见下图：") == 1, "包含关系的两个词各插了一次"
        assert "【开户许可证】见下图：" in result["t1"]

    def test_pure_function_does_not_mutate_input(self):
        """纯函数：返回新 dict,不改动入参 out（缓存回写路径依赖这一点不被污染）。"""
        out = {"t1": "<h3>正文</h3>"}
        state = {
            "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
            "read": _read_with("提供营业执照", ["sec-1-c1"]),
            "run_input": {"credentials": [{"title": "营业执照", "images": []}]},
        }
        place_certificates(out, state)
        assert out["t1"] == "<h3>正文</h3>", "入参被就地改动了"


# ---- ④ 缓存命中章同样获得插图：post-pass 在缓存读写之外,fresh/cached 章一律现算 ----

class _FakeRedis:
    def __init__(self):
        self.kv: dict = {}

    def get(self, k):
        return self.kv.get(k)

    def set(self, k, v, ex=None):
        self.kv[k] = v

    def xadd(self, key, fields, maxlen=None, approximate=True):
        pass


class _FakeChat:
    def __init__(self):
        self.calls = 0

    async def ainvoke(self, msgs, config=None):
        self.calls += 1
        return AIMessage(content=f"<h3>一、正文</h3><p>{'内容' * 60}</p>")


def _cert_state() -> dict:
    return {
        "outline": {"chapters": [_chapter("t1", "资格声明", ["sec-1-c1"])]},
        "read": _read_with("提供营业执照", ["sec-1-c1"]),
        "run_input": {"credentials": [
            {"title": "营业执照", "images": [{"fileId": "f1", "key": "lib/f1.png", "name": "n"}]}]},
    }


def _ctx(redis):
    from types import SimpleNamespace
    return SimpleNamespace(thread_id="proj-t", run_id="r1", redis=redis, gateway=object(),
                           recorder=None, user_id=None, agent_type="bidding_agent")


def test_cached_chapter_still_gets_cert_placement_on_second_run(monkeypatch):
    """④两次 run：第一次现写、第二次断点命中（calls==0）——两次 out 都必须带插图,证明
    post-pass 不依赖缓存路径,库存变化能在缓存命中场景下同样立即生效。"""
    from agent.agents.bidding_agent.nodes import content_pipeline as mod
    from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline

    redis = _FakeRedis()
    state = _cert_state()

    chat1 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat1)
    out1 = asyncio.run(run_content_pipeline(_ctx(redis), state))
    assert chat1.calls == 1
    assert "【营业执照】见下图：" in out1["t1"]

    chat2 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat2)
    out2 = asyncio.run(run_content_pipeline(_ctx(redis), state))
    assert chat2.calls == 0, "断点没命中——不是本测试要验证的对象"
    assert "【营业执照】见下图：" in out2["t1"], "缓存命中章没有拿到证照插图"


def test_library_stock_change_is_reflected_without_touching_cache(monkeypatch):
    """库存变化即时生效：第二次 run 前删光资料库证照，chapter 缓存原封不动命中，但插图
    结果必须从"见下图"变成"待补充"——证明 post-pass 产物真的没有写进章节缓存。"""
    from agent.agents.bidding_agent.nodes import content_pipeline as mod
    from agent.agents.bidding_agent.nodes.content_pipeline import run_content_pipeline

    redis = _FakeRedis()
    state = _cert_state()
    chat1 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat1)
    out1 = asyncio.run(run_content_pipeline(_ctx(redis), state))
    assert "【营业执照】见下图：" in out1["t1"]

    depleted = _cert_state()
    depleted["run_input"]["credentials"] = []       # 资料库证照被删光
    chat2 = _FakeChat()
    monkeypatch.setattr(mod, "resilient_chat", lambda gw, provider=None: chat2)
    out2 = asyncio.run(run_content_pipeline(_ctx(redis), depleted))
    assert chat2.calls == 0, "简报没变，仍应缓存命中"
    assert "（待补充：营业执照）" in out2["t1"]
    assert "见下图" not in out2["t1"]
