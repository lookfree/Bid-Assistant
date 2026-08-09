"""资格证明文件附录系统章节（2026-08-09 附录系统章节设计,Plan A Task 2）：content 步收尾把资料库资质条目
确定性拼成一章 HTML 并追加进提纲——有货就建、无货不建、同代重试不重建不覆盖、
重新生成会重建、墓碑逻辑不误伤这一章。**章内容全程不进模型**，本文件不打任何模型桩，
本身就是"零字进 LLM 上下文"的间接证据——真出现调用桩，说明实现悄悄绕进了模型。
"""
import asyncio
from types import SimpleNamespace

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


def test_same_generation_retry_does_not_rebuild_or_overwrite():
    """③同代重试(outline 已含 sys-creds)不重建不覆盖：图内 outline 已经带着上一次追加的
    系统章（用户可能已编辑/删单图）时，即便 run_input 仍有 credentials，也必须原样返回
    None——不能用一份新构建的 HTML 覆盖用户的编辑。三查任一命中都不动，逐一验证。"""
    outline_with_sys = {"chapters": [
        {"id": "t1", "no": "一", "title": "项目理解", "group": "tech"},
        dict(SYS_CREDS_CHAPTER),
    ]}
    state = {"run_input": {"credentials": _CREDENTIALS}, "outline": outline_with_sys}
    assert append_credentials_chapter(state, {"t1": "<p>x</p>", SYS_CREDS_ID: "<h3>用户编辑过</h3>"}) is None

    # 第三查单独成立：outline 尚不含 sys-creds，但本轮 chapters 已带同 id 键（如断点续跑
    # 命中了上一次的产出）——同样不重建。
    state2 = {"run_input": {"credentials": _CREDENTIALS}, "outline": {"chapters": [{"id": "t1"}]}}
    assert append_credentials_chapter(state2, {SYS_CREDS_ID: "<h3>已经有了</h3>"}) is None


def test_regeneration_with_fresh_outline_rebuilds_the_chapter():
    """④重新生成(传入 outline 无 sys-creds)重建：content_generation+1 后图内 outline 是一份
    全新提纲，不含 sys-creds——三查全过，照常重建并追加系统章字面量。"""
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
