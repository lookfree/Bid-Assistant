"""spec316 A1: store SQL 组装——fake pool 记录执行的 SQL/params,不连真库。"""
import agent.rag.store as store


class _FakeCursor:
    def __init__(self, rows=None):
        self._rows = rows or []

    def fetchall(self):
        return self._rows


class _FakeConn:
    def __init__(self, rows=None, raise_on=None):
        self.executed: list[tuple] = []
        self._rows = rows
        self._raise_on = raise_on or ()

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        for needle in self._raise_on:
            if needle in sql:
                raise TimeoutError("statement timeout")
        return _FakeCursor(self._rows)

    def commit(self):
        pass


class _FakePool:
    def __init__(self, conn):
        self._conn = conn

    def connection(self):
        return self

    def __enter__(self):
        return self._conn

    def __exit__(self, *exc):
        return False


def _no_register(monkeypatch):
    monkeypatch.setattr(store, "register", lambda conn: None)


def test_upsert_deletes_before_insert_with_incrementing_chunk_no(monkeypatch):
    _no_register(monkeypatch)
    conn = _FakeConn()
    pool = _FakePool(conn)
    n = store.upsert(pool, "u1", "library", "src1",
                      chunks=["a", "b", "c"],
                      embeddings=[[0.1], [0.2], [0.3]],
                      metas=[{}, {}, {}])
    assert n == 3
    sqls = [c[0] for c in conn.executed]
    assert "DELETE" in sqls[0].upper()
    assert "src1" in conn.executed[0][1]
    insert_calls = [c for c in conn.executed if "INSERT" in c[0].upper()]
    assert len(insert_calls) == 3
    chunk_nos = [c[1][3] for c in insert_calls]   # (user_id, source_type, source_id, chunk_no, ...)
    assert chunk_nos == [0, 1, 2]


def test_delete_filters_by_user_id_source_type_and_source_id(monkeypatch):
    _no_register(monkeypatch)
    conn = _FakeConn()
    pool = _FakePool(conn)
    store.delete(pool, "owner-1", "library", "src1")
    sql, params = conn.executed[0]
    assert "DELETE" in sql.upper()
    assert "user_id" in sql
    assert params == ("library", "src1", "owner-1")


def test_search_sql_has_cosine_operator_filters_limit_and_timeout(monkeypatch):
    _no_register(monkeypatch)
    rows = [("text one", {"k": "v"}, 0.87)]
    conn = _FakeConn(rows=rows)
    pool = _FakePool(conn)
    result = store.search(pool, "u1", "library", [0.1, 0.2], top_k=5)
    assert result == [{"text": "text one", "meta": {"k": "v"}, "score": 0.87}]
    sqls = [c[0] for c in conn.executed]
    assert any("statement_timeout" in s for s in sqls)
    select_sql = next(s for s in sqls if "SELECT" in s.upper())
    assert "<=>" in select_sql
    assert "user_id" in select_sql and "source_type" in select_sql
    assert "LIMIT" in select_sql.upper()


def test_search_degrades_to_empty_list_on_timeout(monkeypatch):
    _no_register(monkeypatch)
    conn = _FakeConn(raise_on=("SELECT",))
    pool = _FakePool(conn)
    result = store.search(pool, "u1", "library", [0.1, 0.2], top_k=5)
    assert result == []
