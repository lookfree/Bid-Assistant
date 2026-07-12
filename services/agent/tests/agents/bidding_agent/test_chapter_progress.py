import asyncio
import json
from types import SimpleNamespace
from agent.agents.bidding_agent.nodes.content import ChapterProgressCallback


class _FakeRedis:
    def __init__(self):
        self.events = []

    def xadd(self, key, fields):
        self.events.append(json.loads(fields["event"]))


def _ctx(r):
    return SimpleNamespace(redis=r, run_id="run-1")


def test_chapter_write_publishes_progress():
    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx(r), total=3, titles={"t1": "项目理解", "t2": "服务方案"})
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t2.html"}))
    assert len(r.events) == 2
    e = r.events[-1]["data"]
    assert e["kind"] == "chapter" and e["chapterId"] == "t2" and e["title"] == "服务方案"
    assert e["done"] == 2 and e["total"] == 3 and e["doneIds"] == ["t1", "t2"]


def test_duplicate_chapter_write_deduped():
    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx(r), total=2, titles={})
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    assert len(r.events) == 1   # 同章重复写(改稿)只推一次


def test_non_chapter_write_ignored():
    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx(r), total=1, titles={})
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "notes/todo.txt"}))
    assert r.events == []
