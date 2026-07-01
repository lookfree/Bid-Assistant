from psycopg_pool import ConnectionPool
from agent.config import settings

pool = ConnectionPool(conninfo=settings.database_url, min_size=1, max_size=10, open=True)


def ping() -> bool:
    try:
        with pool.connection() as conn:
            conn.execute("select 1")
        return True
    except Exception:
        return False
