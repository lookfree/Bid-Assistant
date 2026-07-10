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
