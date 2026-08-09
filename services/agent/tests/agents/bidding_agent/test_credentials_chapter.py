"""资格证明文件附录系统章节（2026-08-09 附录系统章节设计,Plan A Task 2）：content 步收尾把资料库资质条目
确定性拼成一章 HTML 并追加进提纲——有货就建、无货不建、outline 回灌后仍重建但不重复追加、
墓碑逻辑不误伤这一章、真实流水线端到端跑一遍确认系统章从未被点名要求模型撰写。
**章内容全程不进模型**：除末尾端到端测试外，本文件不打任何模型桩——本身就是"零字进
LLM 上下文"的间接证据，真出现调用桩，说明实现悄悄绕进了模型。
"""
import asyncio
from types import SimpleNamespace

from langchain_core.messages import AIMessage

from agent.agents.bidding_agent.nodes.credentials_chapter import (
    SYS_CREDS_CHAPTER, SYS_CREDS_ID, append_credentials_chapter, build_credentials_chapter,
)

_CREDENTIALS = [
    {"title": "营业执照", "images": [
        {"fileId": "f1", "key": "lib/f1.png", "name": "营业执照.png"},
        {"fileId": "f2", "key": "lib/f2.png", "name": "营业执照2.png"},
    ]},
]


def test_build_chapter_is_pure_deterministic_html_with_no_bytes():
    """①有 credentials 构建：HTML 含 <h3>营业执照</h3> 与三属性占位图，绝不含 base64/src——
    章内容纯代码拼接，一个字都不进模型（大标书几百条元数据也不会撑爆检查点或简报）。
    附带覆盖接口契约的另外两点：空列表回空串；条目标题做 HTML 转义（防 <>" 破坏标签/
    提前闭合 alt 属性）。"""
    html = build_credentials_chapter(_CREDENTIALS)
    assert "<h3>营业执照</h3>" in html
    assert 'data-file-id="f1"' in html and 'data-object-key="lib/f1.png"' in html
    assert 'data-file-id="f2"' in html and 'data-object-key="lib/f2.png"' in html
    assert 'alt="营业执照"' in html
    assert "base64" not in html and "src=" not in html

    assert build_credentials_chapter([]) == ""

    dirty = [{"title": '"><script>alert(1)</script>', "images": [{"fileId": "f3", "key": "k3", "name": "n"}]}]
    escaped = build_credentials_chapter(dirty)
    assert "<script>" not in escaped
    assert "&lt;script&gt;" in escaped and "&quot;" in escaped and "&gt;" in escaped


def test_alt_carries_ocr_text_truncated_to_120_chars():
    """终审 I-4：占位图 alt 从纯标题改为「标题|ocrText 截前 120 字」——与 cert_placement.py
    的章内证照 post-pass 同一套格式（同一个 `_image_alt`，两处调用方共享一份实现）。
    无 ocrText 的附件仍退化为纯标题（既有行为不变）。"""
    long_ocr = "字" * 200
    credentials = [{"title": "营业执照", "images": [
        {"fileId": "f1", "key": "k1", "name": "n1", "ocrText": "统一社会信用代码91xx"},
        {"fileId": "f2", "key": "k2", "name": "n2", "ocrText": long_ocr},
        {"fileId": "f3", "key": "k3", "name": "n3"},
    ]}]
    html = build_credentials_chapter(credentials)
    assert 'alt="营业执照|统一社会信用代码91xx"' in html
    assert f'alt="营业执照|{long_ocr[:120]}"' in html
    assert long_ocr not in html, "完整 200 字版本不该出现，必须截断"
    assert 'alt="营业执照"' in html, "无 ocrText 的附件仍应退化为纯标题"


def test_alt_escapes_title_and_ocr_text_as_one_combined_string():
    """标题与 ocrText 都含需转义字符时，拼接后整串只转义一次——不能各自先转义再拼接
    （否则 "&" 会变成 "&amp;amp;" 的二次转义）。"""
    credentials = [{"title": "A&B", "images": [{"fileId": "f1", "key": "k1", "name": "n1", "ocrText": "C<D>"}]}]
    html = build_credentials_chapter(credentials)
    assert 'alt="A&amp;B|C&lt;D&gt;"' in html
    assert "&amp;amp;" not in html


def _state(credentials=None, outline_chapters=None, extra_run_input=None):
    run_input = dict(extra_run_input or {})
    if credentials is not None:
        run_input["credentials"] = credentials
    return {
        "run_input": run_input,
        "outline": {"chapters": outline_chapters or [
            {"id": "t1", "no": "一", "title": "项目理解", "group": "tech"},
        ]},
        "read": {},
    }


def _run_content_node(state, pipeline_out, monkeypatch):
    """驱动真实 content_node，只打桩 run_content_pipeline（与 test_content_pipeline.py 的
    test_content_node_delegates_to_the_pipeline 同一手法）——附录章的接线必须走真节点验证，
    不能只测 append_credentials_chapter 这个纯函数。"""
    from agent.agents.bidding_agent.nodes import content as content_mod
    from agent.agents.bidding_agent.nodes import content_pipeline as pmod

    async def fake_pipeline(ctx, s):
        return pipeline_out
    monkeypatch.setattr(pmod, "run_content_pipeline", fake_pipeline)
    ctx = SimpleNamespace(thread_id="t", run_id="r", redis=None, gateway=None, recorder=None,
                          agent_type="bidding_agent", user_id=None)
    return asyncio.run(content_mod.make_content_node(ctx)(state))


def test_content_node_without_credentials_leaves_outline_and_chapters_untouched(monkeypatch):
    """②无 credentials → content_node 返回不含 outline 键，chapters 无 sys-creds——
    与 App 侧"有货才下发 credentials 键"的约定一致，键本身缺失时同样不触发。"""
    out = _run_content_node(_state(credentials=None), {"t1": "<p>正文</p>"}, monkeypatch)
    assert "outline" not in out
    assert SYS_CREDS_ID not in out["chapters"]
    assert out["chapters"] == {"t1": "<p>正文</p>"}


def test_rehydrated_outline_with_existing_sys_creds_still_rebuilds_without_duplicating():
    """③（评审 2026-08-09 修正,重建语义）outline 已含 sys-creds——App 侧 state_overrides
    每次触发 content 都会把库里 outline result 回灌进图内状态，这是**常态**而非重试专属的
    边角场景，图里带着上一次追加的系统章不代表内容仍然新鲜。仍要用资料库当前状态重建
    HTML（用户可能已经在资料库里增删证照），但提纲里绝不能因此堆出第二条 sys-creds。"""
    outline_with_sys = {"chapters": [
        {"id": "t1", "no": "一", "title": "项目理解", "group": "tech"},
        dict(SYS_CREDS_CHAPTER),
    ]}
    updated_credentials = _CREDENTIALS + [
        {"title": "资质证书", "images": [{"fileId": "f9", "key": "lib/f9.png", "name": "资质证书.png"}]}]
    state = {"run_input": {"credentials": updated_credentials}, "outline": outline_with_sys}
    stale_html = "<h3>上一次生成时的旧附录（用户可能已编辑）</h3>"
    result = append_credentials_chapter(state, {"t1": "<p>x</p>", SYS_CREDS_ID: stale_html})

    assert result is not None
    ids = [c["id"] for c in result["outline"]["chapters"]]
    assert ids.count(SYS_CREDS_ID) == 1, "outline 里重复追加了 sys-creds"
    assert result["chapters"][SYS_CREDS_ID] == build_credentials_chapter(updated_credentials)
    assert result["chapters"][SYS_CREDS_ID] != stale_html, "没有用资料库当前状态重建，还是旧值"


def test_fresh_outline_without_sys_creds_appends_it():
    """④(简化)outline 尚不含 sys-creds（如首次生成）→ 追加系统章字面量并构建其 HTML。"""
    state = _state(credentials=_CREDENTIALS)
    result = append_credentials_chapter(state, {"t1": "<p>x</p>"})
    assert result is not None
    assert [c["id"] for c in result["outline"]["chapters"]] == ["t1", SYS_CREDS_ID]
    assert result["outline"]["chapters"][-1] == SYS_CREDS_CHAPTER
    assert result["chapters"] == {"t1": "<p>x</p>", SYS_CREDS_ID: build_credentials_chapter(_CREDENTIALS)}


def test_tombstone_logic_does_not_null_out_the_credentials_chapter(monkeypatch):
    """⑤墓碑逻辑不给 sys-creds 打 None：outline 追加后 ids 含它且 chapters 有它——墓碑口径
    必须用追加后的 outline，否则 sys-creds 会被误判"提纲没有此章"而漏算/错算。同时验证
    附录章的加入不松动既有缺章语义：pipeline 真缺的 t2 照常打 None 墓碑。"""
    state = _state(credentials=_CREDENTIALS, outline_chapters=[
        {"id": "t1", "no": "一", "title": "项目理解", "group": "tech"},
        {"id": "t2", "no": "二", "title": "技术方案", "group": "tech"},
    ])
    out = _run_content_node(state, {"t1": "<p>正文</p>"}, monkeypatch)   # pipeline 只交回 t1，t2 视为缺章
    assert out["chapters"]["t2"] is None
    assert out["chapters"][SYS_CREDS_ID] == build_credentials_chapter(_CREDENTIALS)
    assert SYS_CREDS_ID in [c["id"] for c in out["outline"]["chapters"]]


def test_end_to_end_rehydrated_outline_never_calls_the_model_for_sys_creds(monkeypatch):
    """⑥端到端，复现评审 2026-08-09 实证的真实路径：outline 回灌后常态带着 sys-creds，
    这次不打桩 run_content_pipeline 本身，只打桩底层 resilient_chat——驱动真实流水线，
    证明系统章从未被点名要求模型撰写（结构性跳过在流水线层生效），content_node 收尾后
    chapters[sys-creds] 是 build_credentials_chapter 的确定性产物而不是任何模型输出，
    且提纲里只有一条 sys-creds（append 没有重复追加）。"""
    from agent.agents.bidding_agent.nodes import content as content_mod
    from agent.agents.bidding_agent.nodes import content_pipeline as pmod

    class _Chat:
        def __init__(self):
            self.seen: list[str] = []

        async def ainvoke(self, msgs, config=None):
            user = msgs[-1].content
            assert "资格证明文件" not in user, "系统章标题泄漏进了简报——结构性跳过失效"
            self.seen.append(user)
            return AIMessage(content="<h3>一、正文</h3><p>" + "内容" * 60 + "</p>")

    chat = _Chat()
    monkeypatch.setattr(pmod, "resilient_chat", lambda gw, provider=None: chat)

    state = {
        "run_input": {"credentials": _CREDENTIALS},
        "outline": {"chapters": [
            {"id": "t1", "no": "一", "title": "项目理解", "group": "tech"},
            dict(SYS_CREDS_CHAPTER),      # 模拟 state_overrides 回灌：库里 outline 已带 sys-creds
        ]},
        "read": {"categories": []},
    }
    ctx = SimpleNamespace(thread_id="proj-t", run_id="r1", redis=None, gateway=object(),
                          recorder=None, user_id=None, agent_type="bidding_agent")
    out = asyncio.run(content_mod.make_content_node(ctx)(state))

    assert len(chat.seen) == 1, "模型被调用的次数不等于真正要写的章数（只有 t1）"
    assert out["chapters"][SYS_CREDS_ID] == build_credentials_chapter(_CREDENTIALS)
    ids = [c["id"] for c in out["outline"]["chapters"]]
    assert ids.count(SYS_CREDS_ID) == 1
