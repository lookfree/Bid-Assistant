import asyncio

from agent.db import get_pool
from agent.telemetry.schema import setup_telemetry
from agent.checkpointer import setup_checkpointer
from agent.rag.schema import setup_rag


def _ensure_schemas() -> None:
    with get_pool().connection() as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS langgraph")
        conn.commit()


async def main() -> None:
    _ensure_schemas()
    setup_telemetry(get_pool())        # agent schema 观测四表
    await setup_checkpointer()          # langgraph schema checkpointer 四表
    setup_rag(get_pool())               # agent.rag_chunks（spec316，向量已由 DBA CREATE EXTENSION）
    print("[migrate] agent + langgraph 表已就绪")


if __name__ == "__main__":
    asyncio.run(main())
