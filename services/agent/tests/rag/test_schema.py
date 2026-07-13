"""spec316 A1: setup_rag 迁移——幂等建表,不尝试 CREATE EXTENSION(bidsaas 账号无权)。"""
from agent.db import get_pool
from agent.rag.schema import RAG_SQL, setup_rag


def test_setup_rag_creates_table_idempotent():
    pool = get_pool()
    setup_rag(pool)
    setup_rag(pool)  # 二次调用不报错（幂等）
    with pool.connection() as conn:
        rows = conn.execute(
            "select table_name from information_schema.tables "
            "where table_schema='agent' and table_name='rag_chunks'"
        ).fetchall()
    assert {r[0] for r in rows} == {"rag_chunks"}


def test_migration_sql_never_attempts_create_extension():
    assert "CREATE EXTENSION" not in RAG_SQL.upper()


def test_index_strategy_partial_hnsw_for_library_and_scope_btree():
    """HNSW 只服务 library(partial)；tender 走 scope btree + 精确排序；旧全局索引就地迁移删除。"""
    pool = get_pool()
    setup_rag(pool)
    with pool.connection() as conn:
        rows = conn.execute(
            "select indexname from pg_indexes "
            "where schemaname='agent' and tablename='rag_chunks'"
        ).fetchall()
    names = {r[0] for r in rows}
    assert "rag_chunks_scope_idx" in names
    assert "rag_chunks_hnsw_library" in names
    assert "rag_chunks_hnsw" not in names          # 旧全局 HNSW 已删（多用户下后过滤退化）
    assert "rag_chunks_user_idx" not in names      # 被 scope_idx 前缀覆盖
    assert "WHERE source_type = 'library'" in RAG_SQL
