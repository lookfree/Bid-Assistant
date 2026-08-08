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

import asyncio
import logging
import time
from typing import Any

from langchain_openai import ChatOpenAI

from agent.config import settings
from agent.framework.model_stream import (
    ModelIdleTimeout, _is_auth_error, _is_transient_stream_error)

logger = logging.getLogger(__name__)

# 重打同一端点前的间隔（秒）。openai SDK 默认已重试 2 次，紧挨着的第 4 次几乎必落在同一次抖动里。
_SELF_RETRY_DELAY_S = 3


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
        # 超时也算可降级：ModelIdleTimeout 不是网络异常的子类，_is_transient_stream_error 认不出它
        # （forced_stream_submit 那条路是单独 isinstance 判的）。漏了这一句，新加的超时只会把
        # "一直挂着"变成"直接失败"，而不是"换个模型重来"——那还不如不加。
        return isinstance(e, ModelIdleTimeout) or _is_transient_stream_error(e)

    async def _wait_before_self_retry(self) -> None:
        """重打同一个端点之前先等一下。

        openai SDK 默认 max_retries=2 —— 异常传到这里时，**同一端点已经连打过 3 次**。
        紧接着再打第 4 次几乎必然落在同一次抖动里，白花一次调用。换成别的模型则不必等，
        那是另一个端点。注意这几秒救不了长时间宕机，只是给瞬断一个喘息。"""
        if self.fallback_is_self:
            await asyncio.sleep(_SELF_RETRY_DELAY_S)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        """**正文实际走的就是这条路**（langgraph 的执行器调 model.ainvoke，而 ainvoke 只有挂了
        流式回调才转流式——正文挂的三个回调都不是），所以总时长盖必须加在这里。

        非流式没有 token 流可测，"30 秒不吐字"这种空闲判据在这里根本不适用，只能整通调用限时。
        2026-08-08 生产：一次非流式调用挂了 36 分钟没有任何响应，而这条路当时没有任何上限。
        """
        deadline = time.monotonic() + settings.model_round_timeout_s
        try:
            return await self._capped(
                super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs), deadline)
        except Exception as e:  # noqa: BLE001 只接管可降级的两类，见 _should_fallback
            if not self._should_fallback(e):
                raise
            # 挂死之后**不再对同一个端点重来**：自重试是为"瞬断"设的（隔几秒就通了），
            # 而刚刚已经挂满一个总时长盖的端点，再等一轮多半还是挂——那只会把 20 分钟拖成 40 分钟。
            if self.fallback_is_self and isinstance(e, ModelIdleTimeout):
                raise
            logger.warning("主模型调用失败（%s），改用降级模型重试：%s", type(e).__name__, str(e)[:120])
            await self._wait_before_self_retry()
            return await self._capped(
                self.fallback._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs), deadline)

    @staticmethod
    async def _capped(coro, deadline: float):
        """整通调用限时到给定截止时刻；超时抛 ModelIdleTimeout（_should_fallback 显式认它）。
        deadline 由调用方给且两跳共用——各算各的会让"单轮 20 分钟"实际变成 40 分钟。"""
        try:
            return await asyncio.wait_for(coro, timeout=max(deadline - time.monotonic(), 0.01))
        except asyncio.TimeoutError as e:
            raise ModelIdleTimeout() from e

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        """流式路径：**只在第一块之前**才允许降级。
        已经吐出内容再切模型会把两次生成拼在一起，产出四不像——宁可让本次失败。

        三层保护缺一不可（本仓生产铁律）：流式 + 空闲超时 + 单轮总时长盖 + 降级链。
        2026-08-08 生产实测：正文写到第 20/20 章挂死 **26 分钟、一个字都没吐**，而这条路
        当时只有降级链——没有任何超时，挂死了就一直挂着，用户干等、积分冻着。
        空闲超时杀"挂死"，总时长盖杀"慢而不死"（限流下每 20s 吐一个 token 能骗过空闲检测），
        两者都当作可降级错误，交给上面的降级分支换模型重来。
        """
        # 两跳共用一个截止时刻：各算各的会让"单轮 20 分钟"实际变成 40 分钟
        deadline = time.monotonic() + settings.model_round_timeout_s
        it = self._timed(super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs), deadline)
        try:
            first = await it.__anext__()
        except StopAsyncIteration:
            return
        except Exception as e:  # noqa: BLE001
            if not self._should_fallback(e):
                raise
            logger.warning("主模型流式起始失败（%s），改用降级模型：%s", type(e).__name__, str(e)[:120])
            await self._wait_before_self_retry()
            async for c in self._timed(
                    self.fallback._astream(messages, stop=stop, run_manager=run_manager, **kwargs),
                    deadline):
                yield c
            return
        yield first
        async for c in it:
            yield c

    async def _timed(self, stream, deadline: float):
        """给一条流套上首 token 宽限、token 间隔空闲超时、总时长盖（deadline 由调用方给）。

        超时抛 ModelIdleTimeout。**注意它不是网络异常的子类**，_is_transient_stream_error
        认不出它——能进降级通道全靠 _should_fallback 里那句显式 isinstance，别把那句删了。

        deadline 由调用方传入而不是这里现算：主/降级两跳必须共用同一个截止时刻，
        各算各的会让"20 分钟单轮盖"实际变成 40 分钟（审查提出）。
        """
        idle_s = settings.model_idle_timeout_s
        first_s = settings.model_first_token_timeout_s
        it = stream.__aiter__()
        got_any = False
        try:
            while True:
                budget = deadline - time.monotonic()
                if budget <= 0:
                    raise ModelIdleTimeout()      # 总时长顶格：事实不可用，进降级重试
                try:
                    chunk = await asyncio.wait_for(
                        it.__anext__(), timeout=min(first_s if not got_any else idle_s, budget))
                except StopAsyncIteration:
                    return
                except asyncio.TimeoutError as e:
                    raise ModelIdleTimeout() from e
                got_any = True
                yield chunk
        finally:
            # 超时/异常/调用方提前退出都要**立刻关流**，不等 GC：挂死的那条 SSE 连接不关掉，
            # 下面马上又去连降级模型，两条连接同时挂着（model_stream 的 astream_collect 同款处理）。
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:  # noqa: BLE001 关流 best-effort
                    pass


def resilient_chat(gateway, **kw) -> Any:
    """按网关的降级链造一个带降级的模型。

    **没有配降级模型时，第二跳仍然打主模型自己**——与 forced_stream_submit 的
    `tries[1] if len(tries) > 1 else tries[0]` 同一口径。瞬断本就是一瞬的事，同一端点隔一下
    再打通常就成了；此时放弃重试等于把"没配降级"变成"没有任何保护"，而正文恰恰是最长最贵的一步。
    """
    chain = getattr(gateway, "chain", None)
    try:
        items = chain() if callable(chain) else []
    except Exception:  # noqa: BLE001 取链失败绝不能连累正文——在"建模型"这步崩比瞬断更糟
        logger.warning("读取模型链失败，本次无降级", exc_info=True)
        return gateway.get_chat(**kw)
    primary = gateway.get_chat(**kw)
    if not items:
        return primary                      # 连链都取不到（桩装配）：保持原样，不臆造
    if len(items) > 1:
        fb = items[1]
        # 合并而不是并列传参：调用方的 kw 里本就可能有 provider（正文传的就是 provider=None），
        # 再显式写一次会 TypeError，整个正文节点当场崩——链里的取值优先。
        fallback = gateway.get_chat(**{**kw, "provider": fb.get("provider"), "model": fb.get("model"),
                                       "thinking": fb.get("thinking"), "base_url": fb.get("base_url"),
                                       "api_key": fb.get("api_key")})
    else:
        # 第二跳就是主模型自己：**必须用与主模型完全相同的构造参数**，不能拿链里那项去重建。
        # get_chat(provider=None) 的"沿用链首"分支只抄 provider/model/base_url/api_key，
        # **不抄 thinking**，主模型因而用的是全局默认（通常关）。若照链里那项带上 thinking=True，
        # 重试这一跳就成了"另一个模型"：延迟与成本都不同，而且本仓记录过
        # 「思考 + 流式强制 tool_choice = 400」——那会把一次可恢复的瞬断变成必挂的 400。
        fallback = gateway.get_chat(**kw)
    # 用主模型的构造参数重建成 ResilientChat：直接改 primary 的类不安全（pydantic 校验字段）
    data = {k: v for k, v in primary.__dict__.items() if not k.startswith("_")}
    try:
        # 流式与否由配置决定（settings.model_content_streaming，默认关）：
        # 开 = ainvoke 转流式（BaseChatModel._should_stream 认 streaming=True），空闲检测 30 秒发现挂死；
        # 关 = 普通 HTTP 调用，靠 _capped 的 20 分钟总时长盖兜底。
        # 默认关的原因（2026-08-08）：打开当天正文三连败（工具参数拼坏/端点 400），全在首次调用，
        # 同载荷重放四次均通——非确定性，疑为 vLLM 流式工具解析器问题，未钉死前不赌。
        # stream_usage 跟随流式开关：流式下服务商要显式要求才回 usage，否则 token 用量静默丢失。
        stream = bool(getattr(getattr(gateway, "s", None), "model_content_streaming", False))
        return ResilientChat(**{**data, "streaming": stream, "stream_usage": stream,
                                "fallback": fallback, "fallback_is_self": len(items) < 2})
    except Exception:  # noqa: BLE001 构造失败绝不能连累正文生成——退回无降级的原模型
        logger.warning("构造带降级的模型失败，本次无降级", exc_info=True)
        return primary
