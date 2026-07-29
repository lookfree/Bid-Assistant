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


def test_content_slide_without_bullets_is_rejected():
    """生产事故：模型只提交标题、bullets 缺省成空列表 → 14 页全空的 PPT 照样交付并扣 80 积分。
    正文页必须有要点，校验失败会触发强制提交重试；封面/尾页本就无要点，不受此限。"""
    import pytest
    from pydantic import ValidationError
    from agent.agents.bidding_agent.schemas import SlideDraft

    with pytest.raises(ValidationError):
        SlideDraft(id="s2", title="总体技术思路", kind="content")
    with pytest.raises(ValidationError):
        SlideDraft(id="s3", title="实施策略", kind="content", bullets=["  ", ""])  # 空白字符串不算要点
    SlideDraft(id="s1", title="项目名称", kind="cover")                      # 封面无要点合法
    SlideDraft(id="s4", title="致谢", kind="end")                            # 尾页同理
    SlideDraft(id="s5", title="方案框架", kind="content", bullets=["分层解耦，网关统一鉴权"])
