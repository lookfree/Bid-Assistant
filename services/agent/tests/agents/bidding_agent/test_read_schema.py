import asyncio
from agent.agents.bidding_agent.schemas import ReadResult
from agent.framework.structured import make_submit_tool


_SAMPLE = {
    "project_meta": {"name": "某市政务云运维", "code": "ZCY-2026-018", "budget": "￥1,680 万"},
    "categories": [
        {"key": "qualification", "title": "资格要求", "items": [
            {"title": "★信息安全认证", "value": "ISO27001（不可偏离）",
             "clause_ids": ["sec-qualification-c2"], "source_quote": "取得★ISO27001…",
             "status": "found", "risk": True, "star": True},
            {"title": "证明清单", "value": "未给出对照清单", "status": "missing"},
        ]},
    ],
    "scoring": [{"id": "sc-tech-1", "category": "技术方案", "name": "★运维服务体系", "score": 20,
                 "star": True, "clause_ids": ["sec-technical-c2"], "chapter_id": "t3"}],
    "risk_summary": ["ISO27001 不可偏离，缺失即废标"],
}


def test_read_result_validates():
    r = ReadResult(**_SAMPLE)
    assert r.categories[0].items[0].risk is True and r.categories[0].items[1].status == "missing"


def test_read_result_required_structure_defaults_empty():
    """旧读标结果无 required_structure 字段 → 默认空列表（向后兼容，spec321）。"""
    r = ReadResult(**_SAMPLE)
    assert r.required_structure == []


def test_read_result_required_structure_round_trip():
    sample = {**_SAMPLE, "required_structure": [
        {"id": "s1", "title": "技术标（分册）", "kind": "volume", "required": True,
         "clause_ids": ["sec-format-c1"], "source_quote": "投标文件分为技术标、商务标两个分册"},
        {"id": "s2", "title": "密封与签章", "kind": "rule", "required": True,
         "notes": "正本1份副本4份，密封加盖公章骑缝章"},
    ]}
    r = ReadResult(**sample)
    assert [s.id for s in r.required_structure] == ["s1", "s2"]
    assert r.required_structure[0].kind == "volume" and r.required_structure[1].kind == "rule"
    assert r.required_structure[0].required is True and r.required_structure[0].notes == ""


def test_read_result_packages_defaults_empty():
    """旧读标结果无 packages 字段（单包标书）→ 默认空列表（向后兼容，spec324）。"""
    r = ReadResult(**_SAMPLE)
    assert r.packages == []


def test_read_result_packages_round_trip():
    sample = {**_SAMPLE, "packages": [
        {"id": "p1", "name": "实网攻防", "budget": "￥800 万", "notes": "需持攻防资质",
         "clause_ids": ["sec-overview-c3"]},
        {"id": "p2", "name": "态势感知平台建设", "budget": "￥880 万"},
    ]}
    r = ReadResult(**sample)
    assert [p.id for p in r.packages] == ["p1", "p2"]
    assert r.packages[0].name == "实网攻防" and r.packages[0].budget == "￥800 万"
    assert r.packages[1].notes == ""                      # 未给 notes → 默认空串


def test_submit_read_tool_captures():
    tool, get = make_submit_tool("submit_read_result", ReadResult, "提交读标结果")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert isinstance(get(), ReadResult) and get().scoring[0].score == 20


def test_duplicate_category_keys_merged():
    """单轮读标模型把同一类拆成多个同 key 块 → 数据模型层按 key 合并，items 顺序拼接、保留首见 title。
    前端右栏按 key 过滤渲染，重复 key 会一次点击展示多类内容（用户实测「点几次就对不上号/展示全部」）。"""
    sample = {**_SAMPLE, "categories": [
        {"key": "overview", "title": "项目概况", "items": [{"title": "预算", "value": "1680 万"}]},
        {"key": "qualification", "title": "资格要求（一）", "items": [{"title": "A", "value": "a"}]},
        {"key": "qualification", "title": "资格要求（二）", "items": [{"title": "B", "value": "b"}]},
    ]}
    r = ReadResult(**sample)
    keys = [c.key for c in r.categories]
    assert keys == ["overview", "qualification"]                  # 每个 key 唯一
    qual = next(c for c in r.categories if c.key == "qualification")
    assert qual.title == "资格要求（一）"                          # 保留首见 title
    assert [it.title for it in qual.items] == ["A", "B"]          # items 顺序拼接、不丢


def test_submit_read_tool_dedups_categories():
    """经 submit 工具（单轮读标的实际提交路径）提交的重复 key 同样在校验时合并。"""
    tool, get = make_submit_tool("submit_read_result", ReadResult, "提交读标结果")
    sample = {**_SAMPLE, "categories": [
        {"key": "technical", "title": "技术需求", "items": [{"title": "T1", "value": "t1"}]},
        {"key": "technical", "title": "技术需求（续）", "items": [{"title": "T2", "value": "t2"}]},
    ]}
    asyncio.run(tool.ainvoke(sample))
    cats = get().categories
    assert [c.key for c in cats] == ["technical"]
    assert [it.title for it in cats[0].items] == ["T1", "T2"]
