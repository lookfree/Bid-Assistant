from agent.db import get_pool
from agent.telemetry.schema import setup_telemetry

EXPECTED = {"agent_request", "agent_event_log", "agent_token_usage", "agent_tool_call"}


def test_setup_creates_four_tables_idempotent():
    pool = get_pool()
    setup_telemetry(pool)
    setup_telemetry(pool)  # 二次调用不报错（幂等）
    with pool.connection() as conn:
        rows = conn.execute(
            "select table_name from information_schema.tables where table_schema='agent'"
        ).fetchall()
    names = {r[0] for r in rows}
    assert EXPECTED <= names
