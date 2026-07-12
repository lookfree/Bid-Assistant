import asyncio

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from agent.config import settings

# checkpointer 四表落 langgraph schema：连接 options 设 search_path（langgraph 在首位）。
_CONNINFO = settings.database_url + ("&" if "?" in settings.database_url else "?") + "options=-csearch_path%3Dlanggraph,public"

# AsyncPostgresSaver 要求连接 autocommit + dict_row；prepare_threshold=0 避免池化换连接时预处理语句冲突。
_CONN_KW = {"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}

_saver: AsyncPostgresSaver | None = None
_pool: AsyncConnectionPool | None = None
_loop = None    # saver/pool 绑定的事件循环：异步连接池绑 loop，换 loop（多次 asyncio.run）需重建


async def get_checkpointer() -> AsyncPostgresSaver:
    """健康检查连接池支撑的 checkpointer（替代 from_conn_string 的单连接）。
    单连接一旦因隧道瞬断 / PG 空闲超时 / 失联 / 失败转移而断开，就"一断永死"——所有后续
    checkpoint 读写恒抛 the connection is closed，直到进程重启；在途 run 收尾写 checkpoint 失败
    =结果丢失 + 已耗 token 白费 + run 卡 running。改用连接池后（对齐 db.get_pool）：check_connection
    借出前探活、剔除 [BAD] 坏连并重连，max_lifetime 定期换血——网络抖动后自愈，不再需要重启。"""
    global _saver, _pool, _loop
    cur = asyncio.get_running_loop()
    # 当前 loop 变了（迁移/各测试各一个 loop）就重建，否则跨 loop 用会 "attached to a different loop"。
    if _saver is None or _loop is not cur:
        if _pool is not None:
            try:
                await _pool.close()  # best-effort 释放旧池，别每次切 loop 都漏
            except BaseException:  # noqa: BLE001 旧 loop 已关闭：close 内部 gather 旧 loop 上的任务会抛
                pass               # CancelledError（BaseException，非 Exception）——一律吞，交给 GC/OS 回收
        _pool = AsyncConnectionPool(
            _CONNINFO, min_size=1, max_size=8, open=False, kwargs=_CONN_KW,
            check=AsyncConnectionPool.check_connection, max_lifetime=1800, reconnect_timeout=10,
        )
        await _pool.open()   # open(wait=False)：不阻塞启动，连接后台补齐；PG 不可达也不炸 import
        _saver = AsyncPostgresSaver(conn=_pool)
        _loop = cur
    return _saver


async def setup_checkpointer() -> None:
    """建 langgraph 四表（checkpoints/checkpoint_blobs/checkpoint_writes/checkpoint_migrations），幂等。"""
    cp = await get_checkpointer()
    await cp.setup()
