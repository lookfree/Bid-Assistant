"""带降级的聊天模型：主模型瞬断/鉴权失败时自动改用降级模型重试本次调用。

**为什么需要它**：正文生成（content）是全流程唯一不走 framework/create_agent 的节点——
它把模型直接交给 deepagents，于是绕过了 model_stream 那套「流式 + 空闲超时 + 降级链重试」。
代价在生产上很清楚：近 10 天 content 成功 3 次、失败 25 次，其中 **18 次是
`APIConnectionError: Connection error.`**，而连接类错误在其它步骤一次都没有——因为它们
都走 create_agent，瞬断会自动换降级模型再试（2026-08-07 实测）。
正文一跑十几到二十几分钟、按产出字数计费，跑到尾声被一次瞬断打掉，全部作废。

**为什么不用 `Runnable.with_fallbacks`**：它返回 `RunnableWithFallbacks`，没有 `bind_tools`；
deepagents 内部要 `model.bind_tools(...)`，包完就用不了。把降级做进模型对象本身，
`bind_tools` 走继承、行为不变。

判定复用 model_stream 的两个函数（沿 __cause__/__context__ 链下钻）——openai SDK 把连接期
失败包成 APIConnectionError，str() 只有 "Connection error."，只看顶层文案会漏掉最常见的形态。
"""
from __future__ import annotations

import logging
from typing import Any

from langchain_openai import ChatOpenAI

from agent.framework.model_stream import _is_auth_error, _is_transient_stream_error

logger = logging.getLogger(__name__)


class ResilientChat(ChatOpenAI):
    """主模型失败即改用降级模型重试一次。只接管瞬断与鉴权失败，其余（400 语义错误等）原样抛。"""

    fallback: Any = None            # 第二跳用的模型；None = 无降级（行为与原来一致）
    fallback_is_self: bool = False  # 第二跳打的就是主模型自己（运营没配降级模型时）

    def _should_fallback(self, e: BaseException) -> bool:
        if self.fallback is None:
            return False
        # 鉴权失败时，若第二跳就是主模型自己，重试毫无意义：同一把 key 再打一万次还是 401，
        # 只会把一次「配置错误」拖成两倍时长。瞬断才值得对同一端点再试一次。
        if _is_auth_error(e):
            return not self.fallback_is_self
        return _is_transient_stream_error(e)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except Exception as e:  # noqa: BLE001 只接管可降级的两类，见 _should_fallback
            if not self._should_fallback(e):
                raise
            logger.warning("主模型调用失败（%s），改用降级模型重试：%s", type(e).__name__, str(e)[:120])
            return await self.fallback._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        """流式路径：**只在第一块之前**才允许降级。
        已经吐出内容再切模型会把两次生成拼在一起，产出四不像——宁可让本次失败。"""
        it = super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs).__aiter__()
        try:
            first = await it.__anext__()
        except StopAsyncIteration:
            return
        except Exception as e:  # noqa: BLE001
            if not self._should_fallback(e):
                raise
            logger.warning("主模型流式起始失败（%s），改用降级模型：%s", type(e).__name__, str(e)[:120])
            async for c in self.fallback._astream(messages, stop=stop, run_manager=run_manager, **kwargs):
                yield c
            return
        yield first
        async for c in it:
            yield c


def resilient_chat(gateway, **kw) -> Any:
    """按网关的降级链造一个带降级的模型。

    **没有配降级模型时，第二跳仍然打主模型自己**——与 forced_stream_submit 的
    `tries[1] if len(tries) > 1 else tries[0]` 同一口径。瞬断本就是一瞬的事，同一端点隔一下
    再打通常就成了；此时放弃重试等于把"没配降级"变成"没有任何保护"，而正文恰恰是最长最贵的一步。
    """
    chain = getattr(gateway, "chain", None)
    items = chain() if callable(chain) else []
    primary = gateway.get_chat(**kw)
    if not items:
        return primary                      # 连链都取不到（异常/桩装配）：保持原样，不臆造
    fb = items[1] if len(items) > 1 else items[0]
    # 合并而不是并列传参：调用方的 kw 里本就可能有 provider（正文传的就是 provider=None），
    # 再显式写一次会 TypeError，整个正文节点当场崩——链里的取值优先。
    fallback = gateway.get_chat(**{**kw, "provider": fb.get("provider"), "model": fb.get("model"),
                                   "thinking": fb.get("thinking"), "base_url": fb.get("base_url"),
                                   "api_key": fb.get("api_key")})
    # 用主模型的构造参数重建成 ResilientChat：直接改 primary 的类不安全（pydantic 校验字段）
    data = {k: v for k, v in primary.__dict__.items() if not k.startswith("_")}
    try:
        return ResilientChat(**{**data, "fallback": fallback, "fallback_is_self": len(items) < 2})
    except Exception:  # noqa: BLE001 构造失败绝不能连累正文生成——退回无降级的原模型
        logger.warning("构造带降级的模型失败，本次无降级", exc_info=True)
        return primary
