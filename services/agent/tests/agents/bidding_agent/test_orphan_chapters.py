"""删章留下的孤儿键（2026-08-08）。

state 里的 chapters 是**合并**通道——单章改写只更新一章、不能覆盖全量，这是对的。
代价是用户在提纲里删掉的章、以及早期版本混进来的杂项键（线上实测有一条 README.md）
会一直留在状态里。导出按提纲遍历取稿、天然忽略它们，所以一直没人发现；
但另外两处会当真，而且一处**涉及钱**。
"""
import pytest

from agent.agents.bidding_agent.nodes.common import chapters_in_outline

_OUTLINE = {"chapters": [{"id": "t1", "title": "项目理解"}, {"id": "b1", "title": "投标函"}]}


class TestFilter:
    def test_drops_chapters_no_longer_in_the_outline(self):
        out = chapters_in_outline({"t1": "<p>一</p>", "t9": "<p>已删章</p>", "b1": "<p>函</p>"}, _OUTLINE)
        assert set(out) == {"t1", "b1"}

    def test_drops_stray_files(self):
        """deepagent 往虚拟 FS 里写的杂项（线上见过 README.md）同样不该混进正文。"""
        assert "README.md" not in chapters_in_outline({"t1": "<p>一</p>", "README.md": "笔记"}, _OUTLINE)

    def test_keeps_everything_when_there_is_no_outline(self):
        """线下标书审查/述标没有提纲——不能因此把正文全过滤没了。"""
        src = {"sec-1": "<p>线下标书</p>"}
        assert chapters_in_outline(src, {}) == src
        assert chapters_in_outline(src, {"chapters": []}) == src

    def test_does_not_touch_the_chapters_that_remain(self):
        src = {"t1": "<p>一</p>", "b1": "<p>函</p>"}
        assert chapters_in_outline(src, _OUTLINE) == src


class TestWiring:
    """光有函数没用——三处都得真的用上，其中一处直接关系到计费。"""

    @pytest.mark.parametrize("module,fn", [
        ("agent.agents.bidding_agent.nodes.review", "make_review_node"),
        ("agent.agents.bidding_agent.nodes.present", "make_present_node"),
    ])
    def test_review_and_present_filter(self, module, fn):
        import importlib
        import inspect

        src = inspect.getsource(getattr(importlib.import_module(module), fn))
        assert "chapters_in_outline(" in src, f"{fn} 会对已删掉的章做处理"

    def test_reported_result_is_filtered(self):
        """**上报给 App 的正文结果**必须过滤：它既是用户看到的正文，
        也是计费的字数依据——已删掉的章不该继续占字数、把用户顶到更高一档。"""
        import inspect

        from agent.agents.bidding_agent.agent import BiddingAgent

        assert "chapters_in_outline(" in inspect.getsource(BiddingAgent.astream)


class TestEmptyAfterFilter:
    """过滤把正文清空 = 正文与提纲对不上。**这时绝不能继续跑计费步骤**——
    模型拿到空文档，会把整本标书报成"全都没响应"，而用户为此付了钱。
    与"解析不出正文"是同一道闸（那道闸就在几行之上）。"""

    def _ctx(self, gw):
        from agent.runtime.registry import RunContext
        return RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=gw)

    def test_review_refuses_an_emptied_bid(self, submit_gateway):
        import asyncio

        from agent.agents.bidding_agent.nodes.review import make_review_node

        gw = submit_gateway({"submit_risk_report": {"score": 80, "items": [], "passed_items": []}})
        node = make_review_node(self._ctx(gw))
        state = {"read": {"risk_summary": []},
                 "outline": {"chapters": [{"id": "t1", "title": "项目理解"}]},
                 "chapters": {"老章节": "<p>提纲里已经没有这一章了</p>"}}
        with pytest.raises(RuntimeError, match="对不上"):
            asyncio.run(node(state))

    def test_present_refuses_an_emptied_bid(self, submit_gateway):
        import asyncio

        from agent.agents.bidding_agent.nodes.present import make_present_node

        gw = submit_gateway({"submit_deck_draft": {}})
        node = make_present_node(self._ctx(gw))
        state = {"read": {}, "outline": {"chapters": [{"id": "t1", "title": "项目理解"}]},
                 "chapters": {"老章节": "<p>提纲里已经没有这一章了</p>"}, "run_input": {}}
        with pytest.raises(RuntimeError, match="对不上"):
            asyncio.run(node(state))
