from psycopg_pool import ConnectionPool

# vector 扩展由 DBA 预先 CREATE（bidsaas 账号无权 CREATE EXTENSION）；这里只建表，
# 假定 vector 类型已存在（agent schema 已由 telemetry.setup_telemetry 建好，本迁移置其后执行）。
RAG_SQL = """
CREATE TABLE IF NOT EXISTS agent.rag_chunks (
  id          bigserial PRIMARY KEY,
  user_id     uuid        NOT NULL,
  source_type text        NOT NULL,           -- 'library' | 'tender'
  source_id   text        NOT NULL,
  chunk_no    int         NOT NULL,
  text        text        NOT NULL,
  embedding   vector(1024) NOT NULL,
  meta        jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, chunk_no)
);
CREATE INDEX IF NOT EXISTS rag_chunks_user_idx ON agent.rag_chunks (user_id, source_type);
CREATE INDEX IF NOT EXISTS rag_chunks_hnsw ON agent.rag_chunks USING hnsw (embedding vector_cosine_ops);
"""


def setup_rag(pool: ConnectionPool) -> None:
    """幂等建 agent.rag_chunks 表 + 索引（spec316 迁移；不涉及 CREATE EXTENSION）。"""
    with pool.connection() as conn:
        conn.execute(RAG_SQL)
        conn.commit()
