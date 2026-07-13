"""spec316 A1: store SQL 组装——fake pool 记录执行的 SQL/params,不连真库。"""
import agent.rag.store as store


class _FakeCursor:
    def __init__(self, rows=None):
        self._rows = rows or []

    def fetchall(self):
        return self._rows


class _FakeConn:
    def __init__(self, rows=None, raise_on=None, rowcount=0):
        self.executed: list[tuple] = []
        self.executemany_calls: list[tuple] = []
        self._rows = rows
        self._raise_on = raise_on or ()
        self._rowcount = rowcount

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        for needle in self._raise_on:
            if needle in sql:
                raise TimeoutError("statement timeout")
        cur = _FakeCursor(self._rows)
        cur.rowcount = self._rowcount
        return cur

    def cursor(self):
        return self

    def executemany(self, sql, params_seq):
        self.executemany_calls.append((sql, list(params_seq)))

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


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


def test_upsert_deletes_then_batch_inserts_with_incrementing_chunk_no(monkeypatch):
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
    assert "user_id" in sqls[0]                    # DELETE 也按属主隔离，防越权重建他人 chunks
    assert "u1" in conn.executed[0][1] and "src1" in conn.executed[0][1]
    # 批量写：一次 executemany（大项目 ~2000 chunks 逐行 execute 曾拖慢后台索引）
    assert len(conn.executemany_calls) == 1
    sql, rows = conn.executemany_calls[0]
    assert "INSERT" in sql.upper()
    assert [r[3] for r in rows] == [0, 1, 2]      # (user_id, source_type, source_id, chunk_no, ...)


def test_sweep_expired_tender_is_batched_and_activity_aware(monkeypatch):
    _no_register(monkeypatch)
    conn = _FakeConn(rowcount=7)
    pool = _FakePool(conn)
    n = store.sweep_expired_tender(pool, ttl_days=30)
    assert n == 7
    sql, params = conn.executed[0]
    assert "DELETE" in sql.upper()
    assert "source_type='tender'" in sql          # 只清项目向量，绝不动 library 资料库
    assert "created_at" in sql and "make_interval" in sql
    # 活跃感知：TTL 窗口内有过 run 的项目(agent_request 按 thread_id)不清——续跑老项目不丢 RAG
    assert "NOT EXISTS" in sql and "agent_request" in sql
    # 分批：LIMIT 限界单事务大小(无界 DELETE 长事务压 vacuum/锁 upsert/卡停机)
    assert "LIMIT" in sql.upper()
    assert params == (30, 30, store.SWEEP_BATCH_LIMIT)


def test_search_rejects_unknown_source_type(monkeypatch):
    """source_type 内联进 SQL(partial index 需字面量才可证明),必须白名单校验防注入。"""
    _no_register(monkeypatch)
    pool = _FakePool(_FakeConn(rows=[]))
    import pytest
    with pytest.raises(ValueError):
        store.search(pool, "u1", "tender'; DROP TABLE x;--", [0.1], top_k=5)


def test_search_inlines_source_type_literal_for_partial_index(monkeypatch):
    """绑参数时 generic plan 证明不了 partial HNSW 谓词 → source_type 必须是 SQL 字面量。"""
    _no_register(monkeypatch)
    conn = _FakeConn(rows=[])
    pool = _FakePool(conn)
    store.search(pool, "u1", "library", [0.1, 0.2], top_k=5)
    select_sql, params = next((s, p) for s, p in conn.executed if "SELECT" in s.upper())
    assert "source_type='library'" in select_sql
    assert "library" not in params                 # 不再作为绑定参数传入


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


def test_search_scopes_by_source_id_when_given(monkeypatch):
    """spec316 A2 fix：tender chunks 是 per-project（source_id=thread_id）——检索必须按 source_id 隔离，
    否则返回该用户所有投标项目的 tender 条款；给了 source_id → WHERE 追加 AND source_id=%s 且入 params。"""
    _no_register(monkeypatch)
    conn = _FakeConn(rows=[])
    pool = _FakePool(conn)
    store.search(pool, "u1", "tender", [0.1, 0.2], top_k=2, source_id="thread-9")
    select_sql, params = next((s, p) for s, p in conn.executed if "SELECT" in s.upper())
    assert "source_id" in select_sql
    assert "thread-9" in params


def test_search_omits_source_id_filter_when_none(monkeypatch):
    """library 检索 source_id=None → 不加 source_id 过滤（取该用户全部资料库），保持 A1 行为。"""
    _no_register(monkeypatch)
    conn = _FakeConn(rows=[])
    pool = _FakePool(conn)
    store.search(pool, "u1", "library", [0.1, 0.2], top_k=5)
    select_sql, _params = next((s, p) for s, p in conn.executed if "SELECT" in s.upper())
    assert "source_id" not in select_sql
