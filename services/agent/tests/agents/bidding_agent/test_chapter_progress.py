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


def test_write_todos_tool_not_counted_as_chapter():
    """回归：write_todos 规划工具 input 含 "chapters/b5.html"（todo 项）——不是写章节，
    绝不能计数或推进度（之前误判成"写完一章"，计数虚高 + 标题成 repr 残片）。"""
    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx(r), total=20, titles={"b5": "投标报价"})
    todo_input = "{'todos': [{'content': 'write chapters/b5.html', 'status': 'pending'}]}"
    asyncio.run(cb.on_tool_start({"name": "write_todos"}, todo_input,
                                 inputs={"todos": [{"file_path": "chapters/b5.html", "status": "pending"}]}))
    assert r.events == []       # 规划工具不计数


def test_chapter_id_and_title_clean_from_messy_input_str():
    """回归：即便只拿到 write_file 的 input_str（dict repr），也要精确抠出 id=b5、标题查得到，
    而不是把 "b5.html', 'status': ...}" 当成 id（用户实测到的乱码标题）。"""
    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx(r), total=20, titles={"b5": "投标报价"})
    messy = "{'file_path': 'chapters/b5.html', 'content': '<p>...'}"
    asyncio.run(cb.on_tool_start({"name": "write_file"}, messy))
    assert len(r.events) == 1
    e = r.events[0]["data"]
    assert e["chapterId"] == "b5" and e["title"] == "投标报价"
