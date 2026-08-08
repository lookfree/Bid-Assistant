import asyncio
import json
import pytest
from langchain_core.messages import AIMessage, AIMessageChunk
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes import common as common_mod
from agent.agents.bidding_agent.nodes.present import make_present_node


_DRAFT_ARGS = {"title": "述标", "duration": 15, "template": "gov", "slides": [
    {"id": "s0", "title": "封面", "kind": "cover", "bullets": []},
    {"id": "s1", "title": "运维体系", "bullets": ["7×24"], "kind": "content"},
], "qa": [{"q": "可用性？", "a": "99.9%"}]}

_NOTES_ARGS = {"notes": [
    {"id": "s0", "notes": "开场白"},
    {"id": "s1", "notes": "讲稿"},
]}


class _CapGateway:
    """记录发给模型的消息（验证 run_input 注入 prompt），按工具名分派 draft/notes 两套提交参数。"""

    def __init__(self, draft_args: dict, notes_args: dict | None = None):
        self.draft_args = draft_args
        self.notes_args = notes_args or _NOTES_ARGS
        self.msgs: list = []

    def get_chat(self, **kw):
        gw = self

        class _Chat:
            def bind_tools(self, tools, **kw2):
                self.name = tools[0].name
                return self

            async def ainvoke(self, messages):
                gw.msgs.append(messages)
                args = gw.draft_args if self.name == "submit_deck_draft" else gw.notes_args
                return AIMessage(content="", tool_calls=[{"name": self.name, "args": args, "id": "c1"}])

            async def astream(self, messages, **kw2):     # 流式路径（forced_stream_submit）
                gw.msgs.append(messages)
                args = gw.draft_args if self.name == "submit_deck_draft" else gw.notes_args
                yield AIMessageChunk(content="", tool_call_chunks=[
                    {"name": self.name, "args": json.dumps(args), "id": "c1", "index": 0}])
        return _Chat()


def test_present_node_produces_deck_and_pptx_key(monkeypatch, submit_gateway):
    saved = {}

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            saved["key"], saved["len"] = key, len(data)

    monkeypatch.setattr(common_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    node = make_present_node(ctx)
    out = asyncio.run(node({"chapters": {"t3": "<h3>SLA</h3>"}, "read": {}}))
    assert out["deck"]["template"] == "gov"
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"
    assert saved["key"] == "artifacts/proj-1/present.pptx" and saved["len"] > 0   # 真渲染了 .pptx 字节


def test_present_merges_notes_by_slide_id(monkeypatch, submit_gateway):
    """两段合并正确：draft 2 页 + notes 覆盖两页 → notes 来自 notes 段、qa/template 来自 draft 段。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))
    notes_by_id = {s["id"]: s["notes"] for s in out["deck"]["slides"]}
    assert notes_by_id == {"s0": "开场白", "s1": "讲稿"}
    assert out["deck"]["qa"] == [{"q": "可用性？", "a": "99.9%"}]
    assert out["deck"]["template"] == "gov"


def test_present_missing_slide_notes_falls_back_to_empty(monkeypatch, submit_gateway):
    """缺页 notes 兜底：notes 段只覆盖 s1，漏 s0 → s0 的 notes 为空串，不报错，仍出 pptx。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    partial_notes = {"notes": [{"id": "s1", "notes": "讲稿"}]}
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": partial_notes}))
    out = asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))
    notes_by_id = {s["id"]: s["notes"] for s in out["deck"]["slides"]}
    assert notes_by_id == {"s0": "", "s1": "讲稿"}
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"


@pytest.mark.parametrize("empty_notes", [{}, {"notes": []}])
def test_present_notes_pass_all_empty_submission_fails_closed(monkeypatch, submit_gateway, empty_notes):
    """口播稿段整段放弃（提交 {} 缺字段，或 {"notes": []} 空列表）→ SlideNotes 校验失败(必填+min_length=1)、
    重试耗尽 → present_node 抛 RuntimeError，而非静默把整份 deck 的 notes 全置空当成功（Task A 安全网保留）。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": empty_notes}))
    with pytest.raises(RuntimeError):
        asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))


def _run_present(monkeypatch, run_input: dict, draft_args: dict):
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    gw = _CapGateway(draft_args)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1", gateway=gw)
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {}, "read": {}, "run_input": run_input}))
    return out, gw.msgs[0][1].content   # HumanMessage 用户消息（骨架段第一轮）


def test_present_run_input_duration_and_template(monkeypatch):
    """spec315a 契约 4：run_input.duration/template 注入 prompt；template 提交后强制生效。"""
    out, user = _run_present(monkeypatch, {"duration": 10, "template": "gov"},
                             {**_DRAFT_ARGS, "template": "blue"})
    assert "时长 10 分钟" in user
    assert "客户指定模板：gov" in user
    assert out["deck"]["template"] == "gov"       # 模型交 blue 也被强制为客户指定


def test_present_run_input_invalid_falls_back(monkeypatch):
    """非法档位/模板回默认：duration=15，template 不注入不强制（保留模型选择）。"""
    out, user = _run_present(monkeypatch, {"duration": 12, "template": "red"}, _DRAFT_ARGS)
    assert "时长 15 分钟" in user
    assert "客户指定模板" not in user
    assert out["deck"]["template"] == "gov"       # 取自模型提交，未被覆盖


def test_present_enterprise_template_key_fetches_master_and_sets_deck_id(monkeypatch, submit_gateway):
    """企业母版：run_input.enterprise_template_key 给出 → 预取字节（storage_read.read_bytes）
    并传给 render_pptx 的 master_bytes；deck.enterprise_template_id 写回同一 key。"""
    from agent.parsing import storage_read as storage_read_mod
    from agent.agents.bidding_agent.nodes import present as present_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    fetched = []
    monkeypatch.setattr(storage_read_mod, "read_bytes",
                        lambda key: fetched.append(key) or b"fake-master-bytes")
    captured = {}

    def _fake_render_pptx(deck, *, template=None, master_bytes=None):
        captured["master_bytes"] = master_bytes
        return b"PK\x03\x04fake"
    monkeypatch.setattr(present_mod, "render_pptx", _fake_render_pptx)

    key = "library/u1/master.pptx"
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {}, "read": {}, "run_input": {"enterprise_template_key": key}}))
    assert fetched == [key]
    assert captured["master_bytes"] == b"fake-master-bytes"
    assert out["deck"]["enterprise_template_id"] == key


def test_present_enterprise_template_fetch_failure_falls_back_blank(monkeypatch, submit_gateway):
    """取母版字节失败（网络抖动/坏 key）→ master_bytes=None 传给 render_pptx，不抛错；
    deck.enterprise_template_id 仍写回 key（供 export 之后重试）。"""
    from agent.parsing import storage_read as storage_read_mod
    from agent.agents.bidding_agent.nodes import present as present_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    def _raising_read_bytes(key):
        raise RuntimeError("object not found")
    monkeypatch.setattr(storage_read_mod, "read_bytes", _raising_read_bytes)
    captured = {}

    def _fake_render_pptx(deck, *, template=None, master_bytes=None):
        captured["master_bytes"] = master_bytes
        return b"PK\x03\x04fake"
    monkeypatch.setattr(present_mod, "render_pptx", _fake_render_pptx)

    key = "library/u1/missing.pptx"
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {}, "read": {}, "run_input": {"enterprise_template_key": key}}))
    assert captured["master_bytes"] is None
    assert out["deck"]["enterprise_template_id"] == key


def test_present_without_enterprise_template_key_unchanged(monkeypatch, submit_gateway):
    """没有 enterprise_template_key（今天的行为）→ master_bytes=None，deck.enterprise_template_id
    保持模型提交的默认值 None，不因新增功能改变现有产出。"""
    from agent.agents.bidding_agent.nodes import present as present_mod

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())
    captured = {}

    def _fake_render_pptx(deck, *, template=None, master_bytes=None):
        captured["master_bytes"] = master_bytes
        return b"PK\x03\x04fake"
    monkeypatch.setattr(present_mod, "render_pptx", _fake_render_pptx)

    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)({"chapters": {}, "read": {}}))
    assert captured["master_bytes"] is None
    assert out["deck"]["enterprise_template_id"] is None


def test_present_parses_external_bid_when_no_chapters(monkeypatch, submit_gateway):
    """独立述标（spec328，与 review 节点共用 parse_bid_chapters）：chapters 空 + run_input.bid_file_key
    → 确定性解析上传标书成章，述标不依赖是否有招标文件（read 为空也能出 PPT）。"""
    import agent.agents.bidding_agent.nodes.common as common_mod2

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    class _Parsed:
        clauses = [
            {"id": "sec-1-c1", "text": "运维保障方案正文"},
            {"id": "sec-2-c1", "text": "报价合计 100 万元"},
        ]
    monkeypatch.setattr(common_mod2, "read_and_parse", lambda key: _Parsed())

    gw = _CapGateway(_DRAFT_ARGS)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1", gateway=gw)
    out = asyncio.run(make_present_node(ctx)(
        {"read": {}, "run_input": {"bid_file_key": "uploads/u/bid.docx"}}))
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"  # 解析出的章成功走完两段提交产出 PPT
    user_msg = gw.msgs[0][1].content
    assert "运维保障方案正文" in user_msg and "报价合计 100 万元" in user_msg


def test_present_external_bid_parse_empty_fails_loud(monkeypatch, submit_gateway):
    """解析为空（扫描件/图片版）→ 抛错而非拿空文档产假 PPT，run 落 failed 可重试（同 review 节点口径）。"""
    import agent.agents.bidding_agent.nodes.common as common_mod2

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    class _EmptyParsed:
        clauses = []
    monkeypatch.setattr(common_mod2, "read_and_parse", lambda key: _EmptyParsed())

    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    with pytest.raises(RuntimeError, match="扫描件"):
        asyncio.run(make_present_node(ctx)(
            {"read": {}, "run_input": {"bid_file_key": "uploads/u/scan.pdf"}}))


def test_present_filters_read_by_selected_package(monkeypatch):
    """spec324：选包时述标只喂该包评分点，别包的评分/要求过滤掉（此前 present 未过滤，多包件会串包）。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())
    read = {"scoring": [
        {"name": "本包技术方案", "score": 40, "packages": ["p1"]},
        {"name": "别包运维", "score": 30, "packages": ["p2"]},
        {"name": "全包通用报价", "score": 10, "packages": []},
    ]}
    gw = _CapGateway(_DRAFT_ARGS)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1", gateway=gw)
    asyncio.run(make_present_node(ctx)(
        {"chapters": {"t1": "<p>正文</p>"}, "read": read,
         "run_input": {"package": {"id": "p1", "name": "实网攻防"}}}))
    user = gw.msgs[0][1].content  # 骨架段用户消息
    assert "本包技术方案" in user and "全包通用报价" in user  # 该包 + 全包通用项保留
    assert "别包运维" not in user  # 别包专属评分被过滤


def test_present_prefers_existing_chapters_over_bid_file_key(monkeypatch, submit_gateway):
    """已有 chapters（正常生成链路，如 bid-kind 项目）时，即便 run_input 意外带 bid_file_key
    也不触发解析——chapters 非空即不进入 spec328 兜底分支，行为与今天一致。"""
    import agent.agents.bidding_agent.nodes.common as common_mod2

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    def _boom(key):
        raise AssertionError("chapters 非空时不该调用解析")
    monkeypatch.setattr(common_mod2, "read_and_parse", _boom)

    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": _DRAFT_ARGS,
                                             "submit_slide_notes": _NOTES_ARGS}))
    out = asyncio.run(make_present_node(ctx)(
        {"chapters": {"t1": "<p>正文</p>"}, "read": {}, "run_input": {"bid_file_key": "uploads/u/bid.docx"}}))
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"


def test_present_never_delivers_a_title_only_deck(monkeypatch, submit_gateway):
    """生产事故：模型只给标题、bullets 全空，14 页空 PPT 照样交付并扣 80 积分。
    现在两层都会拦：SlideDraft 校验先判无效并要求重提交，节点合并后再兜一道。
    无论撞在哪一层，用户可见结果都是 run 失败 → App 全额退款，绝不交付空 PPT。"""
    import pytest
    import agent.agents.bidding_agent.nodes.common as common_mod2

    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())
    monkeypatch.setattr(common_mod2, "read_and_parse", lambda key: type("P", (), {"clauses": [{"id": "sec-1-c1", "text": "正文"}]})())

    # 骨架直接构造成「正文页无要点」（绕过 schema，模拟历史数据/校验被绕过的情形）
    empty = {"title": "述标", "duration": 15, "template": "blue",
             "slides": [{"id": "s1", "title": "封面", "kind": "cover", "bullets": []},
                        {"id": "s2", "title": "技术方案", "kind": "content", "bullets": []}],
             "qa": []}
    notes = {"notes": [{"id": "s1", "notes": "开场"}, {"id": "s2", "notes": "讲方案"}]}
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": empty, "submit_slide_notes": notes}))
    with pytest.raises(RuntimeError, match="未产出任何页面要点|未通过 submit_deck_draft"):
        asyncio.run(make_present_node(ctx)({"chapters": {"t1": "<p>正文</p>"}, "read": {}}))


def test_chart_only_content_page_does_not_trip_the_empty_deck_guard(monkeypatch, submit_gateway):
    """回归：结构性升级前的兜底判据是 not any(sl.bullets for sl in content_pages)——一份全是
    chart 版式、bullets 都是空列表的合法述标（数据本身就是内容，不需要凑 bullets）会被这条
    旧判据误判为"全空"直接失败。新判据必须按版式识别 chart 页的实质内容，不能只看 bullets。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass
    monkeypatch.setattr(common_mod, "storage", _Storage())

    chart_draft = {"title": "述标", "duration": 15, "template": "blue", "slides": [
        {"id": "s0", "title": "封面", "kind": "cover", "bullets": []},
        {"id": "s1", "title": "团队构成", "kind": "content", "layout": "chart", "bullets": [], "scoring": "团队 20 分",
         "chart": {"type": "pie", "categories": ["高级", "中级"], "series": [{"name": "人数", "values": [3, 6]}]}},
    ], "qa": [{"q": "团队稳定性？", "a": "核心成员合作 5 年以上"}]}
    notes = {"notes": [{"id": "s0", "notes": "开场"}, {"id": "s1", "notes": "团队中 60% 为中级工程师"}]}
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1",
                     gateway=submit_gateway({"submit_deck_draft": chart_draft, "submit_slide_notes": notes}))
    out = asyncio.run(make_present_node(ctx)({"chapters": {"t1": "<p>正文</p>"}, "read": {}}))
    assert out["artifacts"]["pptx"] == "artifacts/proj-1/present.pptx"


def _run_present_with_chapters(monkeypatch, chapters: dict):
    """跑一遍述标骨架段，返回喂给模型的用户消息。"""
    class _Storage:
        async def put_bytes(self, key, data, content_type=None):
            pass

    monkeypatch.setattr(common_mod, "storage", _Storage())
    gw = _CapGateway(_DRAFT_ARGS)
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="proj-1", gateway=gw)
    asyncio.run(make_present_node(ctx)({"chapters": chapters, "read": {}, "run_input": {}}))
    return gw.msgs[0][1].content


def test_present_caps_the_bid_text_it_feeds_the_model(monkeypatch):
    """述标此前完全没有长度上限，整本标书原样喂出去。

    2026-08-08 生产实测：26.5 万字符的正文让输入涨到 98305 tokens，加上后台配的
    max_tokens=32768，超出 131072 的窗口 **1 个 token** —— 400，整步失败退款，
    用户什么都拿不到。大标书的述标是**必炸**而不是偶发。

    断言的是真正的不变式：**整条输入 + 输出配额必须装得进窗口**，
    而不是某个写死的字数——额度是按剩余窗口动态算的，写死数字的断言只会锁死实现。
    """
    from agent.framework.budget import (
        DEFAULT_CONTEXT_WINDOW, _DEFAULT_OUTPUT_RESERVE, estimate_tokens)
    from agent.agents.bidding_agent.prompts.present import PRESENT_SKELETON_PROMPT

    huge = {f"sec-{i}": f"<p>{'投标内容' * 20000}</p>" for i in range(1, 9)}   # 约 64 万字
    user = _run_present_with_chapters(monkeypatch, huge)
    total = estimate_tokens(PRESENT_SKELETON_PROMPT + user) + _DEFAULT_OUTPUT_RESERVE
    assert total < DEFAULT_CONTEXT_WINDOW, f"整条输入 {total} tokens，装不进窗口"


def test_present_keeps_every_chapter_visible(monkeypatch):
    """截断不能让某几章整个消失——短章按原样全给，长章才截。"""
    chapters = {"sec-1": "<p>短章内容</p>", "sec-2": f"<p>{'长章' * 200000}</p>"}
    user = _run_present_with_chapters(monkeypatch, chapters)
    assert "短章内容" in user
    assert "长章" in user
    assert "（截断）" in user      # 长章被截了，且标记出来让模型知道后面还有


def test_present_feeds_everything_when_it_fits(monkeypatch):
    """放得下就一个字都不砍——写死上限的老毛病是把本来放得下的项目也砍掉一半。"""
    chapters = {"sec-1": "<p>" + "正文" * 500 + "结尾标记</p>"}
    user = _run_present_with_chapters(monkeypatch, chapters)
    assert "结尾标记" in user
    assert "（截断）" not in user
