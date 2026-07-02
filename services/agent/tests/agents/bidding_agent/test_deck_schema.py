import asyncio
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "title": "某市政务云运维 述标", "duration": 15, "template": "gov",
    "slides": [
        {"id": "s0", "title": "封面", "kind": "cover", "bullets": []},
        {"id": "s1", "title": "运维服务体系", "scoring": "技术方案 50 分",
         "bullets": ["7×24 值守", "分级 SLA"], "notes": "各位评委，我方运维体系…", "kind": "content"},
        {"id": "s9", "title": "致谢", "kind": "end", "bullets": []},
    ],
    "qa": [{"q": "如何保障 99.9% 可用性？", "a": "统一监控+分级响应+主动巡检…"}],
}


def test_deck_validates():
    d = DeckSpec(**_SAMPLE)
    assert d.duration == 15 and d.slides[0].kind == "cover" and d.qa[0].q.endswith("？")


def test_submit_deck_captures():
    tool, get = make_submit_tool("submit_deck", DeckSpec, "提交述标 DeckSpec")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert get().model_dump() == DeckSpec(**_SAMPLE).model_dump()   # 捕获即原样往返
