"""重写闸（2026-08-08：b8 连写四遍 + 幽灵章 b8_new，22 分钟空转）。

循环持续的原因：write_file 每次都回"写入成功"，错误被确认。闸改成在犯错那一刻纠正：
拒绝写入，回执里直接写明"哪些已完成、还缺哪些"。
"""
import asyncio

from langchain_core.messages import ToolMessage

from agent.framework.rewrite_guard import RewriteGuardMiddleware

_META = {"t1": "项目理解", "t2": "技术方案", "b8": "服务人员配置方案"}


def _req(name="write_file", path="chapters/b8.html", files=None):
    from types import SimpleNamespace
    return SimpleNamespace(
        tool_call={"name": name, "args": {"file_path": path}, "id": "c1"},
        tool=None, state={"files": files or {}}, runtime=None)


async def _handler(request):
    return "写入成功"


def _run(req):
    return asyncio.run(RewriteGuardMiddleware(_META).awrap_tool_call(req, _handler))


class TestGuard:
    def test_rewriting_a_finished_chapter_is_rejected_with_directions(self):
        """重写已完成的章 → 拒绝，且回执要指路（缺哪些章）——光说"不行"模型还会瞎撞。"""
        out = _run(_req(files={"/chapters/b8.html": {"content": "<p>" + "已写好的内容" * 50 + "</p>"}}))
        assert isinstance(out, ToolMessage)
        assert "禁止重写" in out.content
        assert "t1" in out.content and "项目理解" in out.content, "没告诉模型还缺哪些章"

    def test_phantom_chapter_is_rejected(self):
        """提纲外的章（b8_new 那类幽灵章）同样拒绝——此前只是收稿时静默过滤，模型不知道错了。"""
        out = _run(_req(path="chapters/b8_new.html"))
        assert isinstance(out, ToolMessage) and "不在提纲" in out.content

    def test_first_write_passes(self):
        assert _run(_req(files={})) == "写入成功"

    def test_repairing_a_stub_passes(self):
        """残章（内容极短）允许重写修复——拦掉修复就把"防浪费"变成"锁死残次品"。"""
        assert _run(_req(files={"/chapters/b8.html": {"content": "<p>x</p>"}})) == "写入成功"

    def test_other_tools_untouched(self):
        assert _run(_req(name="read_file")) == "写入成功"


def test_guard_is_wired_with_the_outline(monkeypatch):
    """闸要挂上，且要拿到**提纲的章表**——没有章表它指不了路。"""
    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from agents.bidding_agent.test_content_node import _FakeDeep, _ctx
    from agent.agents.bidding_agent.nodes import content as content_mod

    seen = {}

    def _capture(**kw):
        seen["mw"] = kw.get("middleware") or []
        return _FakeDeep({"/chapters/t1.html": {"content": "<p>x</p>"}})

    monkeypatch.setattr(content_mod, "create_deep_agent", _capture)
    asyncio.run(content_mod.make_content_node(_ctx())(
        {"outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
         "read": {}}))
    guard = next((m for m in seen["mw"] if isinstance(m, RewriteGuardMiddleware)), None)
    assert guard is not None, "重写闸没挂进 deepagent"
    assert guard._meta == {"t1": "项目理解"}, "闸没拿到提纲章表，指不了路"
