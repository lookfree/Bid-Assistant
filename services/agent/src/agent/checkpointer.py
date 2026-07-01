import asyncio

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from agent.config import settings

# checkpointer 四表落 langgraph schema：连接 options 设 search_path（langgraph 在首位）。
_CONNINFO = settings.database_url + ("&" if "?" in settings.database_url else "?") + "options=-csearch_path%3Dlanggraph,public"

_saver: AsyncPostgresSaver | None = None
_cm = None      # 保留 from_conn_string 的上下文管理器，避免被 GC 提前关闭连接池
_loop = None    # saver 绑定的事件循环：AsyncPostgresSaver 的异步连接池绑 loop，换 loop 需重建


async def get_checkpointer() -> AsyncPostgresSaver:
    global _saver, _cm, _loop
    cur = asyncio.get_running_loop()
    # 当前 loop 变了（多次 asyncio.run：迁移/各测试各一个 loop）就重建，否则跨 loop 用会 "attached to a different loop"。
    if _saver is None or _loop is not cur:
        if _cm is not None:
            try:
                await _cm.__aexit__(None, None, None)  # best-effort 释放旧连接池，别每次切 loop 都漏
            except Exception:  # noqa: BLE001 旧 loop 多已关闭，关不掉就交给 GC
                pass
        _cm = AsyncPostgresSaver.from_conn_string(_CONNINFO)
        _saver = await _cm.__aenter__()  # 进入 CM 得到真正的 saver（建立连接池）
        _loop = cur
    return _saver


async def setup_checkpointer() -> None:
    """建 langgraph 四表（checkpoints/checkpoint_blobs/checkpoint_writes/checkpoint_migrations），幂等。"""
    cp = await get_checkpointer()
    await cp.setup()
