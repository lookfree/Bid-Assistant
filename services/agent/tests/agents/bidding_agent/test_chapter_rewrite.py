import asyncio
from langchain_core.messages import AIMessage
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.content import rewrite_chapter


class _RewriteChat:
    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        return AIMessage(content="<h3>3.3 服务级别承诺 SLA</h3><p>新增分级 SLA 响应时间表…</p>")


class _GW:
    def get_chat(self, **kw):
        return _RewriteChat()


def test_rewrite_chapter_returns_new_html():
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t", gateway=_GW())
    state = {"chapters": {"t3": "<h3>3.3 SLA</h3><p>旧…</p>"}}
    html = asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA 响应时间表", state))
    assert "分级 SLA 响应时间表" in html and html.startswith("<h3>")
