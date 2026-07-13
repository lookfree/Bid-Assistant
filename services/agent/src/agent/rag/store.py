"""spec316 A1: pgvector 读写——psycopg + agent.rag_chunks，cosine top-k 检索 2s 超时降级。"""
from __future__ import annotations

import logging

from pgvector import Vector
from pgvector.psycopg import register_vector
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

logger = logging.getLogger(__name__)

STATEMENT_TIMEOUT_MS = 2000


def register(conn) -> None:
    """每连接注册一次 vector 类型（pgvector 官方推荐做法）。"""
    register_vector(conn)


def upsert(pool: ConnectionPool, user_id: str, source_type: str, source_id: str,
           chunks: list[str], embeddings: list[list[float]], metas: list[dict]) -> int:
    """先删旧（按属主 user_id+source_type+source_id 重建），再顺序插入（chunk_no 递增）。返回写入条数。
    DELETE 带 user_id：UNIQUE 约束不含 user_id，不加属主条件会让 user_id 不匹配的调用删+改写他人 chunks。"""
    rows = [
        (user_id, source_type, source_id, i, text, Vector(embedding), Jsonb(meta or {}))
        for i, (text, embedding, meta) in enumerate(zip(chunks, embeddings, metas))
    ]
    with pool.connection() as conn:
        register(conn)
        conn.execute(
            "DELETE FROM agent.rag_chunks WHERE source_type=%s AND source_id=%s AND user_id=%s",
            (source_type, source_id, user_id),
        )
        # executemany 走 pipeline 批量提交:大项目 ~2000 chunks 逐行 execute 是 2000 次往返,
        # 曾把一次后台索引拖到分钟级(索引越大 HNSW 每行维护越贵,更放大逐行开销)。
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO agent.rag_chunks
                   (user_id, source_type, source_id, chunk_no, text, embedding, meta)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                rows,
            )
        conn.commit()
    return len(rows)


def delete(pool: ConnectionPool, user_id: str, source_type: str, source_id: str) -> None:
    """按属主删除（user_id 必须匹配，防止越权删他人资料）。"""
    with pool.connection() as conn:
        conn.execute(
            "DELETE FROM agent.rag_chunks WHERE source_type=%s AND source_id=%s AND user_id=%s",
            (source_type, source_id, user_id),
        )
        conn.commit()


SWEEP_BATCH_LIMIT = 5000


def sweep_expired_tender(pool: ConnectionPool, ttl_days: int,
                         batch_limit: int = SWEEP_BATCH_LIMIT) -> int:
    """删一批超期且不再活跃的 tender chunks。活跃判定=该项目(thread)在 TTL 窗口内有过
    任意 run(agent_request 按 thread_id 有索引)——只按 created_at 一刀切会把超期后仍在
    续跑/改章的老项目向量清掉,正文静默丢 RAG。单批 LIMIT 限界事务大小(无界 DELETE 会
    长事务压 vacuum、锁并发 upsert、卡优雅停机),调用方循环到删净。返回本批删除行数。"""
    with pool.connection() as conn:
        cur = conn.execute(
            """DELETE FROM agent.rag_chunks WHERE id IN (
                 SELECT c.id FROM agent.rag_chunks c
                 WHERE c.source_type='tender'
                   AND c.created_at < now() - make_interval(days => %s)
                   AND NOT EXISTS (
                     SELECT 1 FROM agent.agent_request r
                     WHERE r.thread_id = c.source_id
                       AND r.created_at > now() - make_interval(days => %s))
                 LIMIT %s)""",
            (ttl_days, ttl_days, batch_limit),
        )
        conn.commit()
        return cur.rowcount


def search(pool: ConnectionPool, user_id: str, source_type: str,
           query_vec: list[float], top_k: int = 5, source_id: str | None = None) -> list[dict]:
    """cosine 近邻检索；user_id/source_type 严格隔离；2s 超时降级为空列表（不阻塞生成链路）。
    source_id 给定时再按来源隔离（tender chunks 是 per-project source_id=thread_id，
    否则会串到该用户其它投标项目的 tender 条款）；None 时不加此过滤（如 library 取全部资料库）。
    source_type 白名单校验后内联为字面量：绑参数时 prepared statement 的 generic plan 无法
    证明其匹配 partial HNSW(WHERE source_type='library') 的谓词 → 退化为全量精确扫描。"""
    if source_type not in ("library", "tender"):
        raise ValueError(f"unknown source_type: {source_type}")
    qv = Vector(query_vec)
    where = f"user_id=%s AND source_type='{source_type}'"
    params: list = [qv, user_id]
    if source_id is not None:
        where += " AND source_id=%s"
        params.append(source_id)
    params.extend([qv, top_k])
    try:
        with pool.connection() as conn:
            register(conn)
            conn.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT_MS}ms'")
            cur = conn.execute(
                f"""SELECT text, meta, 1 - (embedding <=> %s) AS score
                   FROM agent.rag_chunks
                   WHERE {where}
                   ORDER BY embedding <=> %s
                   LIMIT %s""",
                tuple(params),
            )
            rows = cur.fetchall()
            conn.commit()
    except Exception:  # noqa: BLE001 超时/连接异常一律降级为空结果，不影响生成主流程
        logger.warning("rag search degraded to empty (timeout or db error)", exc_info=True)
        return []
    return [{"text": r[0], "meta": r[1], "score": r[2]} for r in rows]
