from agent.agents.bidding_agent.nodes.common import filter_read_by_package

_READ = {
    "project_meta": {"name": "x"},
    "categories": [
        {"key": "technical", "title": "技术", "items": [
            {"title": "T1", "value": "v", "packages": ["p1"]},
            {"title": "T2", "value": "v", "packages": ["p2"]},
            {"title": "T-通用", "value": "v", "packages": []},
        ]},
        {"key": "qualification", "title": "资格", "items": [
            {"title": "Q通用", "value": "v"},   # 无 packages 字段=通用
        ]},
    ],
    "scoring": [
        {"id": "sc1", "category": "技术", "name": "包1评分", "score": 10, "packages": ["p1"]},
        {"id": "sc2", "category": "技术", "name": "包2评分", "score": 10, "packages": ["p2"]},
    ],
    "required_structure": [
        {"id": "s1", "title": "技术偏离表", "kind": "form", "packages": ["p1"]},
        {"id": "s2", "title": "资格证明", "kind": "volume", "packages": []},
    ],
}


def test_no_package_selected_returns_read_unchanged():
    """铁律:未选包(单包标书/缺省)→ 原样返回,同一对象,零改动。"""
    assert filter_read_by_package(_READ, None) is _READ
    assert filter_read_by_package(_READ, {}) is _READ
    assert filter_read_by_package(_READ, {"package": {}}) is _READ


def test_selecting_p1_keeps_p1_and_common_drops_p2():
    out = filter_read_by_package(_READ, {"package": {"id": "p1", "name": "包1"}})
    tech = next(c for c in out["categories"] if c["key"] == "technical")["items"]
    titles = {t["title"] for t in tech}
    assert titles == {"T1", "T-通用"}                 # 包1专属 + 通用；包2 专属 T2 被过滤
    qual = next(c for c in out["categories"] if c["key"] == "qualification")["items"]
    assert len(qual) == 1                             # 无 packages 字段=通用,保留
    assert [s["id"] for s in out["scoring"]] == ["sc1"]           # 只留包1评分
    assert [s["id"] for s in out["required_structure"]] == ["s1", "s2"]  # 包1专属 + 通用


def test_original_not_mutated():
    """过滤返回新对象,不改原 read(state 里的 read 供其它步复用)。"""
    filter_read_by_package(_READ, {"package": {"id": "p1", "name": "包1"}})
    tech = next(c for c in _READ["categories"] if c["key"] == "technical")["items"]
    assert len(tech) == 3   # 原 read 三条技术项一条没少
