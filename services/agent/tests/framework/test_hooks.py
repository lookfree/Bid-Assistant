"""run_turn 的契约测试。

原来只有一条（断言 pre/post 顺序）。加了否决信号、失败路径、failure_policy、
改验分离、部分应用回滚之后，每条语义都得有一个用例钉住——
钩子系统的价值全在「关键时刻挡了一下」，而那一下在生产里是没有痕迹的，
只能靠测试证明它真的会挡。
"""
import asyncio

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from agent.framework.hooks import (
    FAIL, IGNORE, AgentHook, BuildMessagesHook, DropMalformedToolCallsHook,
    ValidatingHook, run_turn,
)


class _FakeLLM:
    def __init__(self, content="ok"):
        self.content = content
        self.calls = 0

    async def ainvoke(self, messages):
        self.calls += 1
        return AIMessage(content=self.content)


class _BoomLLM:
    def __init__(self):
        self.calls = 0

    async def ainvoke(self, messages):
        self.calls += 1
        raise RuntimeError("端点炸了")


class _OrderHook(AgentHook):
    def __init__(self, log, name="m"):
        self.log, self.name = log, name

    async def pre_invoke(self, ctx):
        self.log.append(f"pre:{self.name}")

    async def post_invoke(self, ctx):
        self.log.append(f"post:{self.name}")

    async def on_failure(self, ctx):
        self.log.append(f"fail:{self.name}")


class _OrderValidator(ValidatingHook):
    def __init__(self, log, name="v"):
        self.log, self.name = log, name

    async def pre_invoke(self, view):
        self.log.append(f"pre:{self.name}")

    async def post_invoke(self, view):
        self.log.append(f"post:{self.name}")


def _state():
    return {"messages": [HumanMessage(content="hi")]}


# ---------------------------------------------------------------- 原有契约

async def test_order_and_system_prompt():
    log = []
    hooks = [BuildMessagesHook("SYS"), _OrderHook(log)]
    ctx = await run_turn(hooks, _FakeLLM(), _state(), None)
    assert log == ["pre:m", "post:m"]                    # pre 全跑→LLM→post 全跑
    assert isinstance(ctx.messages[0], SystemMessage)     # 系统提示注入
    assert ctx.result.content == "ok"


async def test_drop_malformed_tool_calls():
    class _LLM:
        async def ainvoke(self, messages):
            msg = AIMessage(content="")
            msg.tool_calls = [{"name": "good", "args": {}, "id": "1"},
                              {"name": "", "args": {}, "id": "2"}]
            return msg

    ctx = await run_turn([DropMalformedToolCallsHook()], _LLM(), _state(), None)
    assert [c["name"] for c in ctx.result.tool_calls] == ["good"]


# ---------------------------------------------------------------- 一、否决信号

async def test_deny_in_pre_skips_llm():
    """pre 阶段否决 → LLM 一次都不能调。这是「日志系统」和「控制系统」的分界线。"""
    class _Guard(ValidatingHook):
        async def pre_invoke(self, view):
            view.deny("预算不足")

    llm = _FakeLLM()
    ctx = await run_turn([BuildMessagesHook("SYS"), _Guard()], llm, _state(), None)
    assert llm.calls == 0
    assert ctx.denied and ctx.deny_reason == "预算不足"
    assert ctx.denied_by == "_Guard"                      # 挡住的那一下要留名
    assert ctx.result.content == "预算不足"                # 调用方不必判空
    assert ctx.result.response_metadata["denied"] is True


async def test_deny_in_pre_stops_later_hooks():
    """全票通过制：一票否决之后，后面的钩子不再跑。"""
    log = []

    class _Guard(ValidatingHook):
        async def pre_invoke(self, view):
            log.append("guard")
            view.deny("no")

    hooks = [_Guard(), _OrderValidator(log, "after")]
    await run_turn(hooks, _FakeLLM(), _state(), None)
    assert log == ["guard"]


async def test_deny_in_post_replaces_output():
    """post 阶段否决：模型已经说了，但这话不能出去。"""
    class _Guard(ValidatingHook):
        async def post_invoke(self, view):
            if "违规" in view.result.content:
                view.deny("内容未通过校验")

    ctx = await run_turn([_Guard()], _FakeLLM("这里有违规内容"), _state(), None)
    assert ctx.result.content == "内容未通过校验"


async def test_deny_in_post_keeps_usage_metadata():
    """顶掉模型输出，不能把用量一起顶掉——这一轮的 token 是真烧了的。
    make_agent_node 的埋点读的是最终这条消息，丢了就等于该轮上报 0。"""
    class _UsageLLM:
        async def ainvoke(self, messages):
            msg = AIMessage(content="违规内容", response_metadata={"model_name": "x"})
            msg.usage_metadata = {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}
            return msg

    class _Guard(ValidatingHook):
        async def post_invoke(self, view):
            view.deny("内容未通过校验")

    ctx = await run_turn([_Guard()], _UsageLLM(), _state(), None)
    assert ctx.result.content == "内容未通过校验"
    assert ctx.result.usage_metadata["total_tokens"] == 120       # 用量随行
    assert ctx.result.response_metadata["model_name"] == "x"      # 模型归属也带着
    assert ctx.result.response_metadata["denied"] is True


async def test_deny_in_pre_has_no_usage():
    """pre 阶段否决没调过 LLM，不该凭空造出用量。"""
    class _Guard(ValidatingHook):
        async def pre_invoke(self, view):
            view.deny("预算不足")

    ctx = await run_turn([_Guard()], _FakeLLM(), _state(), None)
    assert getattr(ctx.result, "usage_metadata", None) is None


# ---------------------------------------------------------------- 二、失败路径

async def test_on_failure_runs_when_llm_raises():
    """LLM 抛异常，收尾钩子照样跑，异常原样往上抛。
    没有这条，把 settle/release 挂进 post_invoke 的那天，钱会永远挂着。"""
    log = []
    llm = _BoomLLM()
    with pytest.raises(RuntimeError, match="端点炸了"):
        await run_turn([_OrderHook(log)], llm, _state(), None)
    assert log == ["pre:m", "fail:m"]                     # post 没跑，fail 跑了


async def test_on_failure_sees_the_error():
    seen = {}

    class _H(AgentHook):
        async def on_failure(self, ctx):
            seen["err"] = ctx.error
            seen["denied"] = ctx.denied

    with pytest.raises(RuntimeError):
        await run_turn([_H()], _BoomLLM(), _state(), None)
    assert isinstance(seen["err"], RuntimeError) and seen["denied"] is False


async def test_on_failure_runs_on_deny():
    """否决也是「这一轮没能正常出结果」，资源该释放照样要释放。"""
    log = []

    class _Guard(ValidatingHook):
        async def pre_invoke(self, view):
            view.deny("no")

    await run_turn([_OrderHook(log), _Guard()], _FakeLLM(), _state(), None)
    assert log == ["pre:m", "fail:m"]


async def test_on_failure_error_does_not_mask_original():
    """收尾钩子自己抛错不许顶掉真因——否则排查时看到的是收尾代码的栈。"""
    class _BadCleanup(AgentHook):
        async def on_failure(self, ctx):
            raise ValueError("收尾也炸了")

    with pytest.raises(RuntimeError, match="端点炸了"):
        await run_turn([_BadCleanup()], _BoomLLM(), _state(), None)


# ---------------------------------------------------------------- 三、failure_policy

async def test_failure_policy_fail_is_default():
    """默认 Fail = 改造前的行为：钩子抛错，整轮失败。"""
    class _Bad(AgentHook):
        async def pre_invoke(self, ctx):
            raise ValueError("钩子炸了")

    assert _Bad.failure_policy == FAIL
    with pytest.raises(ValueError, match="钩子炸了"):
        await run_turn([_Bad()], _FakeLLM(), _state(), None)


async def test_failure_policy_ignore_skips_and_continues():
    """Ignore = 这个钩子挂了不该让用户的活干不成。"""
    class _BadTelemetry(AgentHook):
        failure_policy = IGNORE

        async def post_invoke(self, ctx):
            raise ValueError("埋点服务抖了")

    llm = _FakeLLM()
    ctx = await run_turn([_BadTelemetry()], llm, _state(), None)
    assert llm.calls == 1 and ctx.result.content == "ok"


async def test_ignore_does_not_swallow_cancellation():
    """CancelledError 是 BaseException，任何策略下都必须往上走，
    否则一个 Ignore 钩子就能把整个 run 的取消信号吃掉。"""
    class _Cancelling(AgentHook):
        failure_policy = IGNORE

        async def pre_invoke(self, ctx):
            raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_turn([_Cancelling()], _FakeLLM(), _state(), None)


# ---------------------------------------------------------------- 四、改验分离

async def test_validating_runs_after_all_mutating():
    """列表里校验钩子排在前面，也必须等所有变形钩子跑完才轮到它——
    否则插件 A 校验完、插件 B 又把对象改了，A 那次校验就白做了。"""
    log = []
    hooks = [_OrderValidator(log, "v"), _OrderHook(log, "m1"), _OrderHook(log, "m2")]
    await run_turn(hooks, _FakeLLM(), _state(), None)
    assert log == ["pre:m1", "pre:m2", "pre:v", "post:m1", "post:m2", "post:v"]


async def test_validator_sees_final_state():
    seen = {}

    class _Mutator(AgentHook):
        async def pre_invoke(self, ctx):
            ctx.messages = [SystemMessage(content="改过了")]

    class _V(ValidatingHook):
        async def pre_invoke(self, view):
            seen["msgs"] = [m.content for m in view.messages]

    await run_turn([_V(), _Mutator()], _FakeLLM(), _state(), None)
    assert seen["msgs"] == ["改过了"]


async def test_validator_cannot_mutate():
    """只读视图：能看能否决，改不了。约定靠人守，约束靠代码守。"""
    errs = []

    class _V(ValidatingHook):
        async def pre_invoke(self, view):
            try:
                view.messages = []
            except AttributeError as e:
                errs.append(str(e))
            assert isinstance(view.messages, tuple)       # 容器级也改不动
            with pytest.raises(TypeError):
                view.state["messages"] = []

    await run_turn([_V()], _FakeLLM(), _state(), None)
    assert errs and "不能改" in errs[0]


# ---------------------------------------------------------------- 五、部分应用回滚

async def test_pre_chain_failure_rolls_back_earlier_mutations():
    """第 N 个钩子炸了，前面 N-1 个已经改过的 ctx 要整体丢弃，
    不把改了一半的状态交给收尾钩子。"""
    seen = {}

    class _Mutator(AgentHook):
        async def pre_invoke(self, ctx):
            ctx.messages = [SystemMessage(content="改了一半")]
            ctx.output_extras["half"] = True

    class _Boom(AgentHook):
        async def pre_invoke(self, ctx):
            raise ValueError("第二个钩子炸了")

    class _Watch(AgentHook):
        async def on_failure(self, ctx):
            seen["msgs"] = list(ctx.messages)
            seen["extras"] = dict(ctx.output_extras)

    with pytest.raises(ValueError, match="第二个钩子炸了"):
        await run_turn([_Mutator(), _Boom(), _Watch()], _FakeLLM(), _state(), None)
    assert seen["msgs"] == [] and seen["extras"] == {}


async def test_state_is_not_mutated_by_the_turn():
    """state 是调用方（langgraph）的，一轮跑完不该被动过。"""
    st = _state()
    before = list(st["messages"])
    await run_turn([BuildMessagesHook("SYS")], _FakeLLM(), st, None)
    assert st["messages"] == before


async def test_denied_output_keeps_usage_metadata():
    """post 否决顶掉模型输出时，**用量元数据必须随否决消息带走**——make_agent_node 的
    用量埋点读的就是这条消息，丢了它 = 该轮真实烧掉的 token 记 0，agent 对 App 的
    上报失真（agent 只报用量、但必须如实报，铁律）。"""
    class _UsageLLM:
        async def ainvoke(self, messages):
            msg = AIMessage(content="这里有违规内容",
                            response_metadata={"model_name": "m1"})
            msg.usage_metadata = {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150}
            return msg

    class _Guard(ValidatingHook):
        async def post_invoke(self, view):
            view.deny("内容未通过校验")

    ctx = await run_turn([_Guard()], _UsageLLM(), _state(), None)
    assert ctx.result.content == "内容未通过校验"
    assert ctx.result.usage_metadata == {"input_tokens": 120, "output_tokens": 30, "total_tokens": 150}
    assert ctx.result.response_metadata.get("model_name") == "m1"   # 归属模型同样保留
    assert ctx.result.response_metadata["denied"] is True
