import asyncio
from agent.framework.backend import InStateBackend, create_backend_tools


def test_in_state_backend_roundtrip():
    b = InStateBackend()

    async def run():
        await b.write_file("/SOUL.md", "hello")
        assert await b.read_file("/SOUL.md") == "hello"
        await b.edit_file("/SOUL.md", "hello", "world")
        assert await b.read_file("/SOUL.md") == "world"
        assert "/SOUL.md" in await b.list_files("/")

    asyncio.run(run())


def test_create_backend_tools_no_execute_by_default():
    tools = create_backend_tools(InStateBackend())
    names = {t.name for t in tools}
    assert {"read_file", "write_file", "edit_file", "list_files"} <= names
    assert "execute" not in names           # 默认不开 shell（§4.5）
