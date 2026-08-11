"""publish_phase 的结构化完成度（读标进度条的数据来源）。"""
import json

import pytest

from agent.runtime.progress import publish_phase


class _Redis:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def xadd(self, _stream, fields, **_kw):
        self.sent.append(json.loads(fields["event"])["data"])


class _Ctx:
    def __init__(self, redis) -> None:
        self.redis = redis
        self.run_id = "run-1"


@pytest.mark.asyncio
async def test_done_total_go_out_as_fields_not_only_in_the_chinese_label():
    """数字必须走字段。前端若从文案里正则抠数字，改一个字（加「(续跑复用 2)」后缀）就静默打歪。"""
    r = _Redis()
    await publish_phase(_Ctx(r), "读标·并行提取中 已完成 3/9 轮(续跑复用 2)", 3, 9)
    assert r.sent[0]["done"] == 3
    assert r.sent[0]["total"] == 9


@pytest.mark.asyncio
async def test_no_numbers_still_publishes_the_label():
    """不带数字的阶段（大多数步）照旧只发文案，不许因为加了新字段就丢事件。"""
    r = _Redis()
    await publish_phase(_Ctx(r), "审查中")
    assert r.sent[0] == {"kind": "phase", "label": "审查中"}


@pytest.mark.asyncio
async def test_zero_total_does_not_ship_a_divide_by_zero_bar():
    """total=0 只发文案：除以零画不出百分比，宁可退回纯文字。"""
    r = _Redis()
    await publish_phase(_Ctx(r), "读标·并行提取中", 0, 0)
    assert "total" not in r.sent[0]
