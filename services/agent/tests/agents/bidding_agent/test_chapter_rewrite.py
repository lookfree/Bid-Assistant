import asyncio
from agent.runtime.registry import RunContext
from agent.agents.bidding_agent.nodes.content import rewrite_chapter

_NEW_HTML = "<h3>3.3 服务级别承诺 SLA</h3><p>新增分级 SLA 响应时间表…</p>"


def test_rewrite_chapter_returns_new_html(submit_gateway):
    ctx = RunContext(run_id="r", agent_type="bidding_agent", thread_id="t",
                     gateway=submit_gateway({}, reply=_NEW_HTML))   # 纯文本回复模式
    state = {"chapters": {"t3": "<h3>3.3 SLA</h3><p>旧…</p>"}}
    html = asyncio.run(rewrite_chapter(ctx, "t3", "补充分级 SLA 响应时间表", state))
    assert "分级 SLA 响应时间表" in html and html.startswith("<h3>")
