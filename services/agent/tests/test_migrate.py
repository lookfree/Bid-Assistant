import asyncio

from agent.db import get_pool
from agent.migrate import main as migrate_main


def test_migrate_creates_both_schemas():
    asyncio.run(migrate_main())
    with get_pool().connection() as conn:
        agent_n = conn.execute(
            "select count(*) from information_schema.tables where table_schema='agent'"
        ).fetchone()[0]
        lg = conn.execute(
            "select count(*) from information_schema.tables where table_schema='langgraph' and table_name like 'checkpoint%'"
        ).fetchone()[0]
    assert agent_n >= 4 and lg >= 3   # checkpoints/blobs/writes(+migrations)
