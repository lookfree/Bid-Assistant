from __future__ import annotations

from typing import Any

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool


class Recorder:
    def __init__(self, pool: ConnectionPool) -> None:
        self._pool = pool

    def start_run(
        self, run_id: str, agent_type: str, thread_id: str,
        file_refs: list[str] | None = None, input_summary: dict[str, Any] | None = None,
    ) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_request
                     (run_id, thread_id, agent_type, status, file_refs, input_summary, started_at)
                   values (%s,%s,%s,'running',%s,%s, now())
                   on conflict (run_id) do update set status='running', started_at=now()""",
                (run_id, thread_id, agent_type,
                 Jsonb(file_refs) if file_refs else None, Jsonb(input_summary) if input_summary else None),
            )
            conn.commit()

    def log_event(
        self, run_id: str, agent_type: str, event_type: str,
        node: str | None = None, level: str = "info",
        data: dict[str, Any] | None = None, event_meta: dict[str, Any] | None = None,
        thread_id: str | None = None,
    ) -> None:
        # seq：run 内单调递增（同一 run 由单 worker 串行写，子查询取 max+1 原子安全）
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_event_log
                     (run_id, thread_id, agent_type, seq, event_type, node, level, data, event_meta)
                   values (%s,%s,%s,
                           (select coalesce(max(seq),0)+1 from agent.agent_event_log where run_id=%s),
                           %s,%s,%s,%s,%s)""",
                (run_id, thread_id, agent_type, run_id,
                 event_type, node, level, Jsonb(data) if data else None, Jsonb(event_meta) if event_meta else None),
            )
            conn.commit()

    def record_usage(
        self, run_id: str, agent_type: str, provider: str, model: str,
        input_tokens: int, output_tokens: int, cached_tokens: int = 0, reasoning_tokens: int = 0,
        total_tokens: int | None = None, node: str | None = None,
        ttft_ms: int | None = None, latency_ms: int | None = None,
        finish_reason: str | None = None, thread_id: str | None = None,
    ) -> None:
        total = total_tokens if total_tokens is not None else input_tokens + output_tokens
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_token_usage
                     (run_id, thread_id, agent_type, provider, model, node,
                      input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens, ttft_ms, latency_ms, finish_reason)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (run_id, thread_id, agent_type, provider, model, node,
                 input_tokens, output_tokens, cached_tokens, reasoning_tokens, total, ttft_ms, latency_ms, finish_reason),
            )
            conn.commit()

    def record_tool(
        self, run_id: str, agent_type: str, tool: str, ok: bool = True,
        duration_ms: int | None = None, args_summary: dict[str, Any] | None = None,
        error: str | None = None, node: str | None = None, thread_id: str | None = None,
    ) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """insert into agent.agent_tool_call (run_id, thread_id, agent_type, tool, node, ok, duration_ms, args_summary, error)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (run_id, thread_id, agent_type, tool, node, ok, duration_ms, Jsonb(args_summary) if args_summary else None, error),
            )
            conn.commit()

    def finish_run(
        self, run_id: str, status: str, error: str | None = None,
        error_type: str | None = None, node_count: int | None = None,
    ) -> None:
        # 完成时回填用量汇总到 agent_request（聚合缓存，列表页免 join）
        with self._pool.connection() as conn:
            conn.execute(
                """update agent.agent_request a
                     set status=%s, error=%s, error_type=%s,
                         node_count=coalesce(%s, node_count),
                         finished_at=now(),
                         duration_ms=cast(extract(epoch from (now()-coalesce(started_at, created_at)))*1000 as int),
                         input_tokens  = coalesce((select sum(input_tokens)  from agent.agent_token_usage where run_id=a.run_id),0),
                         output_tokens = coalesce((select sum(output_tokens) from agent.agent_token_usage where run_id=a.run_id),0),
                         cached_tokens = coalesce((select sum(cached_tokens) from agent.agent_token_usage where run_id=a.run_id),0),
                         total_tokens  = coalesce((select sum(total_tokens)  from agent.agent_token_usage where run_id=a.run_id),0)
                   where a.run_id=%s""",
                (status, error, error_type, node_count, run_id),
            )
            conn.commit()

    def usage_summary(self, run_id: str) -> dict[str, int]:
        with self._pool.connection() as conn:
            row = conn.execute(
                """select coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                          coalesce(sum(cached_tokens),0), coalesce(sum(total_tokens),0), count(*)
                   from agent.agent_token_usage where run_id=%s""",
                (run_id,),
            ).fetchone()
        return {"input": row[0], "output": row[1], "cached": row[2], "total": row[3], "calls": row[4]}
