"""Agent 轮次钩子：插在「模型要说话」和「话真的算数」之间的那一层。

设计参照 kube-apiserver 的准入控制（admission control）：
  - 改和验拆开，先跑完全部 mutating 再跑 validating（否则先校验后修改，校验白做）
  - 全票通过制：任一钩子否决，这一轮就不放行
  - failurePolicy 由每个钩子自己声明，不由框架一刀切
  - 准入链上的修改是「未提交」的，没走到落盘就整体丢弃

与 K8s 的两处差别都是刻意的：
  - 没抄 rules/namespaceSelector（爆炸半径声明）——本框架的钩子按 agent 子类挂，
    作用域在构造时就定死了，再加一层声明是空转。
  - 没抄认证 webhook 的 cache-ttl——目前没有需要查外部依赖的钩子。真出现了再加。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any

from langchain_core.messages import AIMessage, SystemMessage

logger = logging.getLogger(__name__)

# 钩子自身抛错时怎么办，命名照抄 K8s webhook 的 failurePolicy。
# Fail：钩子挂了这一轮就失败——守卫类必须这样，宁可整轮失败也不能当它放行了。
# Ignore：钩子挂了就跳过——观测/增强类该这样，埋点抖一下不该让用户的活干不成。
FAIL = "Fail"
IGNORE = "Ignore"


@dataclass
class AgentTurnContext:
    """一轮的可变工作区。state 是调用方（langgraph）的，钩子只读；其余字段钩子可改。"""
    state: dict
    config: Any = None
    messages: list = field(default_factory=list)
    llm: Any = None
    result: Any = None                       # LLM 调用后的 AIMessage
    output_extras: dict = field(default_factory=dict)

    denied: bool = False                     # 被钩子否决
    deny_reason: str = ""
    denied_by: str = ""                      # 哪个钩子否的——挡住的那一下最没痕迹，得留个名
    error: BaseException | None = None       # LLM 抛的异常，on_failure 里可读

    def deny(self, reason: str) -> None:
        """否决这一轮。pre 阶段否决 → 不调 LLM；post 阶段否决 → 用 reason 顶掉模型输出。"""
        self.denied = True
        self.deny_reason = reason


class TurnView:
    """校验钩子拿到的只读视图。

    K8s 靠两种 CRD 把「能改」和「只能验」拆成两类资源，Python 这边靠这个视图拿到同一个约束。
    挡得住重新赋值和容器级改动，挡不住 result.content = x 这种对象内部的改——
    那是 Python 的边界，不是设计的边界。真要防得靠 deepcopy，不值这个开销。
    """
    __slots__ = ("_ctx",)

    def __init__(self, ctx: AgentTurnContext) -> None:
        object.__setattr__(self, "_ctx", ctx)

    @property
    def state(self) -> Any:
        return MappingProxyType(self._ctx.state)

    @property
    def messages(self) -> tuple:
        return tuple(self._ctx.messages)

    @property
    def output_extras(self) -> Any:
        return MappingProxyType(self._ctx.output_extras)

    @property
    def config(self) -> Any:
        return self._ctx.config

    @property
    def llm(self) -> Any:
        return self._ctx.llm

    @property
    def result(self) -> Any:
        return self._ctx.result

    @property
    def error(self) -> BaseException | None:
        return self._ctx.error

    def deny(self, reason: str) -> None:
        self._ctx.deny(reason)

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError(f"ValidatingHook 不能改 ctx（试图写 {name}）；要改请用 AgentHook")


class AgentHook:
    """变形钩子：能看能改。对应 MutatingWebhookConfiguration。"""

    failure_policy: str = FAIL               # 默认 Fail = 保持改造前的行为（钩子抛错即整轮失败）

    async def pre_invoke(self, ctx: AgentTurnContext) -> None: ...
    async def post_invoke(self, ctx: AgentTurnContext) -> None: ...

    async def on_failure(self, ctx: AgentTurnContext) -> None:
        """这一轮没能正常出结果时跑：LLM 抛异常，或被任一钩子否决。

        post_invoke 和 on_failure 合起来才是 finally 语义。跟钱、跟锁、跟资源释放
        有关的收尾必须放这儿，只挂 post_invoke 的话 LLM 一超时就永远不会释放。
        """
        ...


class ValidatingHook(AgentHook):
    """校验钩子：只能看和否决。对应 ValidatingWebhookConfiguration。

    run_turn 保证它在同阶段所有变形钩子之后才跑，所以它看到的一定是最终态。
    """

    async def pre_invoke(self, view: TurnView) -> None: ...      # type: ignore[override]
    async def post_invoke(self, view: TurnView) -> None: ...     # type: ignore[override]


class BuildMessagesHook(AgentHook):
    """注入系统提示 + 用历史拼消息。"""
    def __init__(self, prompt: str | None = None):
        self._prompt = prompt

    async def pre_invoke(self, ctx: AgentTurnContext) -> None:
        history = list(ctx.state.get("messages", []))
        ctx.messages = ([SystemMessage(content=self._prompt)] + history) if self._prompt else history


class DropMalformedToolCallsHook(AgentHook):
    """丢弃模型产出的畸形 tool call（无 name/args），避免下游崩。"""
    async def post_invoke(self, ctx: AgentTurnContext) -> None:
        res = ctx.result
        calls = getattr(res, "tool_calls", None)
        if calls:
            good = [c for c in calls if c.get("name")]
            if len(good) != len(calls):
                res.tool_calls = good


# ---------------------------------------------------------------- 运行时

def _snapshot(ctx: AgentTurnContext) -> tuple:
    """轮内可变字段的浅快照。state 不在内——它是调用方的，钩子本来就不该改。"""
    return (list(ctx.messages), ctx.llm, dict(ctx.output_extras))


def _restore(ctx: AgentTurnContext, snap: tuple) -> None:
    ctx.messages, ctx.llm, ctx.output_extras = list(snap[0]), snap[1], dict(snap[2])


async def _run_one(hook: AgentHook, method, arg, ctx: AgentTurnContext) -> None:
    """跑一个钩子，按它自己声明的 failure_policy 处理它抛的错。

    只吞 Exception：CancelledError / KeyboardInterrupt 属于 BaseException，
    任何策略下都必须原样往上走，否则 Ignore 的钩子能把整个 run 的取消信号吃掉。
    """
    try:
        await method(arg)
    except Exception:                        # noqa: BLE001 由 failure_policy 决定吞不吞
        if hook.failure_policy == IGNORE:
            logger.warning("钩子 %s.%s 失败，failure_policy=Ignore，跳过继续",
                           type(hook).__name__, method.__name__, exc_info=True)
            return
        raise
    if ctx.denied and not ctx.denied_by:
        ctx.denied_by = type(hook).__name__


async def _run_chain(hooks: list[AgentHook], phase: str, ctx: AgentTurnContext) -> None:
    """跑一个阶段：先全部变形钩子，再全部校验钩子（K8s 的先改后验）。任一否决即停。"""
    mutating = [h for h in hooks if not isinstance(h, ValidatingHook)]
    validating = [h for h in hooks if isinstance(h, ValidatingHook)]

    for h in mutating:
        if ctx.denied:
            return
        await _run_one(h, getattr(h, phase), ctx, ctx)

    view = TurnView(ctx)
    for h in validating:
        if ctx.denied:
            return
        await _run_one(h, getattr(h, phase), view, ctx)


async def _run_failure_chain(hooks: list[AgentHook], ctx: AgentTurnContext) -> None:
    """收尾链。这里的钩子无论声明什么策略都不许把错抛出去——
    on_failure 抛错会顶掉真正的异常，排查时看到的就是收尾代码的栈，真因没了。"""
    for h in hooks:
        try:
            await h.on_failure(ctx)
        except Exception:                    # noqa: BLE001 见上
            logger.warning("钩子 %s.on_failure 失败，已忽略以保留原始异常",
                           type(h).__name__, exc_info=True)


def _denied_message(ctx: AgentTurnContext, original: Any = None) -> AIMessage:
    """否决消息。original=被顶掉的模型输出（post 阶段否决才有）：它的用量/模型归属
    元数据必须搬过来——make_agent_node 的用量埋点读的是最终这条消息，丢了等于该轮
    真实烧掉的 token 记 0，agent 对 App 的上报失真（用量必须如实报，铁律）。"""
    meta = dict(getattr(original, "response_metadata", None) or {})
    meta.update({"denied": True, "denied_by": ctx.denied_by})
    msg = AIMessage(content=ctx.deny_reason, response_metadata=meta)
    usage = getattr(original, "usage_metadata", None)
    if usage is not None:
        msg.usage_metadata = usage
    return msg


async def run_turn(hooks: list[AgentHook], llm: Any, state: dict, config: Any) -> AgentTurnContext:
    """跑一轮：pre 链 → LLM → post 链。任一阶段被否决就短路，收尾链保证一定跑。

    返回的 ctx.result 永远是个 AIMessage（被否决时内容是否决理由），调用方不必判空。
    """
    ctx = AgentTurnContext(state=state, config=config, llm=llm)
    snap = _snapshot(ctx)

    # ---- pre ----
    try:
        await _run_chain(hooks, "pre_invoke", ctx)
    except BaseException as e:
        # 部分应用：前面的钩子已经改过 ctx，第 N 个才炸。改动整体丢弃，
        # 不把改了一半的状态交出去。K8s 的等价物是准入链改的是副本，没落盘就不算数。
        _restore(ctx, snap)
        ctx.error = e
        await _run_failure_chain(hooks, ctx)
        raise

    if ctx.denied:
        _restore(ctx, snap)
        ctx.result = _denied_message(ctx)
        await _run_failure_chain(hooks, ctx)
        return ctx

    # ---- LLM ----
    try:
        ctx.result = await ctx.llm.ainvoke(ctx.messages)   # 钩子可在 pre 改 ctx.llm（如绑 tool_choice）
    except BaseException as e:
        ctx.error = e
        await _run_failure_chain(hooks, ctx)
        raise

    # ---- post ----
    try:
        await _run_chain(hooks, "post_invoke", ctx)
    except BaseException as e:
        ctx.error = e
        await _run_failure_chain(hooks, ctx)
        raise

    if ctx.denied:
        # post 阶段否决：模型已经说了，但这话不能出去，用理由顶掉（用量元数据随行）。
        ctx.result = _denied_message(ctx, original=ctx.result)
        await _run_failure_chain(hooks, ctx)

    return ctx
