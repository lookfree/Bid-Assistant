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


def test_write_todos_without_name_not_counted():
    """回归（name 门失败放行）：serialized 无 name（None）时名字门会放行，必须靠"只信结构化 file_path"
    兜住——write_todos 的 repr 里含 chapters/b5.html（todo 项），不能落到 input_str 正则误计成写章。"""
    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx(r), total=20, titles={"b5": "投标报价"})
    todo_input = "{'todos': [{'content': 'write chapters/b5.html', 'status': 'pending'}]}"
    asyncio.run(cb.on_tool_start(None, todo_input, inputs={"todos": [{"file_path": "chapters/b5.html"}]}))
    assert r.events == []       # serialized=None 也不能误计


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


class _CapRecorder:
    def __init__(self):
        self.events = []

    def log_event(self, run_id, agent_type, event_type, **kw):
        self.events.append({"event_type": event_type, **kw})


def _ctx_pg(r, rec):
    return SimpleNamespace(redis=r, run_id="run-1", recorder=rec,
                           agent_type="bidding_agent", thread_id="t1")


def test_chapter_done_also_logged_to_pg():
    """2026-08-01 空转事故盲区：正文步 60 分钟，agent_event_log 只有一条 run.start——章节完成
    只推 Redis（24h 过期），事后无从复盘。首写一章除推流外必须落一条 chapter.done。"""
    rec = _CapRecorder()
    cb = ChapterProgressCallback(_ctx_pg(_FakeRedis(), rec), total=2, titles={"t1": "项目理解"})
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    done = [e for e in rec.events if e["event_type"] == "chapter.done"]
    assert len(done) == 1
    assert done[0]["data"]["chapterId"] == "t1" and done[0]["data"]["done"] == 1


def test_chapter_rewrite_logged_to_pg_not_redis():
    """同一章第二次被写入 = 模型在重写已完成的章（上下文压缩丢进度的信号）。事故当天 5 次整章
    重写只能靠人肉对 token_usage 时间线推断——现在每次重写落一条 chapter.rewrite(level=warn)。
    Redis 进度流不推（前端计数会虚高），只进 PG。"""
    rec = _CapRecorder()
    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx_pg(r, rec), total=2, titles={"t1": "项目理解"})
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    assert len(r.events) == 1                     # 前端进度只推首写，不虚高
    rewrites = [e for e in rec.events if e["event_type"] == "chapter.rewrite"]
    assert len(rewrites) == 2 and rewrites[-1]["level"] == "warn"
    assert rewrites[-1]["data"]["rewrite"] == 2   # 第 N 次重写


def test_pg_logging_failure_never_breaks_progress():
    class _Boom:
        def log_event(self, *a, **k):
            raise RuntimeError("pg down")

    r = _FakeRedis()
    cb = ChapterProgressCallback(_ctx_pg(r, _Boom()), total=1, titles={})
    asyncio.run(cb.on_tool_start({"name": "write_file"}, "", inputs={"file_path": "chapters/t1.html"}))
    assert len(r.events) == 1   # PG 埋点炸了，Redis 进度照推
