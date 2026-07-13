from psycopg_pool import ConnectionPool

# vector 扩展由 DBA 预先 CREATE（bidsaas 账号无权 CREATE EXTENSION）；这里只建表，
# 假定 vector 类型已存在（agent schema 已由 telemetry.setup_telemetry 建好，本迁移置其后执行）。
#
# 索引策略：HNSW 只建在 library 上（全资料库 ANN 才需要近似索引）。tender 检索永远限定
# 单项目 ~2k 行（scope_idx 定位 + 精确 cosine 排序），成本与表总量无关；若沿用全局 HNSW，
# 多用户规模下图遍历找到的近邻绝大多数会被 user/project 过滤扔掉 → 延迟暴涨 → 触发 2s
# statement_timeout 静默降级为空（RAG 悄悄失效）。DROP 两条旧索引 = 存量库的就地迁移（幂等）。
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
CREATE INDEX IF NOT EXISTS rag_chunks_scope_idx ON agent.rag_chunks (user_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS rag_chunks_hnsw_library ON agent.rag_chunks
  USING hnsw (embedding vector_cosine_ops) WHERE source_type = 'library';
DROP INDEX IF EXISTS agent.rag_chunks_hnsw;
DROP INDEX IF EXISTS agent.rag_chunks_user_idx;
"""


def setup_rag(pool: ConnectionPool) -> None:
    """幂等建 agent.rag_chunks 表 + 索引（spec316 迁移；不涉及 CREATE EXTENSION）。"""
    with pool.connection() as conn:
        conn.execute(RAG_SQL)
        conn.commit()
