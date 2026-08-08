"""子写手并发上限（2026-08-08，产品定为 5）。

规划者会把十几章一波全派，15 路各带 ~5 万 token 预填充同时打自建端点——吞吐被挤满，
谁都吐不出字，横幅几分钟不动；端点反复"掉线"多半也是被打满。闸在 task 执行层：
超限的派发排队等位，轻工具（读写文件）不受影响。
"""
import asyncio

import pytest

from agent.framework.limit_parallel import LimitParallelWritersMiddleware


@pytest.fixture(autouse=True)
def _use_deepagent_engine(monkeypatch):
    """本模块测的是 deepagent 旧引擎（引擎开关默认已切到代码编排流水线，任务 #84）。
    旧引擎保留为配置回退，这些测试守住的就是那条回退路——别删，删了回退等于没验证。"""
    from agent.config import settings as _s
    monkeypatch.setattr(_s, "model_content_engine", "deepagent")


def _req(name: str):
    from types import SimpleNamespace
    return SimpleNamespace(tool_call={"name": name, "args": {}, "id": "c"}, tool=None,
                           state={}, runtime=None)


class TestGate:
    def test_task_dispatch_is_capped(self):
        """同一时刻真正执行的 task 不得超过上限，超出的排队；全部最终都要执行到。"""
        mw = LimitParallelWritersMiddleware(max_parallel=2)
        running = {"now": 0, "peak": 0, "done": 0}

        async def handler(request):
            running["now"] += 1
            running["peak"] = max(running["peak"], running["now"])
            await asyncio.sleep(0.02)          # 模拟子写手写一章
            running["now"] -= 1
            running["done"] += 1
            return "ok"

        async def main():
            await asyncio.gather(*[mw.awrap_tool_call(_req("task"), handler) for _ in range(15)])

        asyncio.run(main())
        assert running["done"] == 15, "排队的派发被丢了——章会缺"
        assert running["peak"] == 2, f"并发峰值 {running['peak']}，闸没起作用"

    def test_light_tools_are_not_queued(self):
        """读写文件这类轻工具不排队——闸错对象会把整个流程拖成串行。"""
        mw = LimitParallelWritersMiddleware(max_parallel=1)
        peak = {"now": 0, "max": 0}

        async def handler(request):
            peak["now"] += 1
            peak["max"] = max(peak["max"], peak["now"])
            await asyncio.sleep(0.02)
            peak["now"] -= 1
            return "ok"

        async def main():
            await asyncio.gather(*[mw.awrap_tool_call(_req("write_file"), handler) for _ in range(6)])

        asyncio.run(main())
        assert peak["max"] == 6, "轻工具也被闸了"

    def test_default_comes_from_settings(self):
        from agent.config import Settings

        assert Settings(database_url="postgresql://x/x").model_content_max_parallel == 5, \
            "默认上限不是产品定的 5"


def test_gate_is_wired_into_the_deep_agent(monkeypatch):
    """闸必须真的挂上——今天第四次防"写了但没接上"。"""
    import sys, pathlib
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from agents.bidding_agent.test_content_node import _FakeDeep, _ctx
    from agent.agents.bidding_agent.nodes import content as content_mod


    seen = {}

    def _capture(**kw):
        seen["middleware"] = kw.get("middleware") or []
        return _FakeDeep({"/chapters/t1.html": {"content": "<p>x</p>"}})

    monkeypatch.setattr(content_mod, "create_deep_agent", _capture)
    asyncio.run(content_mod.make_content_node(_ctx())(
        {"outline": {"chapters": [{"id": "t1", "no": "第一章", "title": "项目理解", "group": "tech"}]},
         "read": {}}))
    assert any(isinstance(m, LimitParallelWritersMiddleware) for m in seen["middleware"]), \
        "并发闸没挂进 deepagent——15 路照样一起冲端点"
