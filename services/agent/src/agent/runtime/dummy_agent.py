from typing import AsyncIterator

from agent.runtime.registry import RunContext, register


class DummyAgent:
    async def astream(self, input: dict, ctx: RunContext) -> AsyncIterator[dict]:
        text = str(input.get("text", ""))
        yield {"type": "node.start", "node": "echo"}
        for i, ch in enumerate(text):
            yield {"type": "chunk", "node": "echo", "data": {"delta": ch, "i": i}}
        yield {"type": "node.end", "node": "echo", "data": {"result": {"echo": text, "len": len(text)}}}


register("dummy", lambda: DummyAgent())
