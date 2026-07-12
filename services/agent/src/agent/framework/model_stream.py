from __future__ import annotations

import logging
import time
from asyncio import TimeoutError as AsyncTimeoutError, wait_for

from langchain_core.messages import AIMessageChunk

from agent.config import settings
from agent.models.usage import extract_usage, record_ctx_usage
from agent.runtime.progress import publish_event, publish_phase

logger = logging.getLogger(__name__)

_HEARTBEAT_S = 4   # 块内心跳节流：token 持续吐时每 ~4s 才推一条「生成中」，避免刷屏进度流


class ModelIdleTimeout(Exception):
    """流式调用连续超时秒数无新 token —— 判定连接挂死；正常慢生成（token 持续吐）不会触发。"""


# 思考型模型（DeepSeek v4-flash/v4-pro 等）流式下会进 thinking 模式，与强制 tool_choice 不兼容（400）。
# 记住这类模型 → 后续同模型直接走非流式 ainvoke，不再每次先撞一个 400。进程级缓存，重启即清。
_NO_STREAM_SUBMIT: set[tuple] = set()


def _model_key(it: dict) -> tuple:
    return (it.get("base_url"), it.get("provider"), it.get("model"))


def _is_thinking_toolchoice_error(e: Exception) -> bool:
    """识别"思考模式不支持强制 tool_choice"的 400（如 DeepSeek
    "Thinking mode does not support this tool_choice"）—— 该模型流式无法强制提交，退回 ainvoke。"""
    s = str(e).lower()
    return "tool_choice" in s and ("thinking" in s or "not support" in s)


def _grown_chars(agg) -> int:
    """已生成字符数（心跳展示用）：正文走 content；强制 submit 走 tool_call_chunks 的 args 增量。"""
    n = len(getattr(agg, "content", "") or "")
    for tc in (getattr(agg, "tool_call_chunks", None) or []):
        n += len(tc.get("args") or "")
    return n


async def astream_collect(chat, messages, ctx, label: str | None):
    """流式收集模型输出 + 空闲超时兜底：
    - 首 token 给 model_first_token_timeout_s 宽限（连接+大 prompt 预填慢但健康）；
    - 之后每个 token 间隔超过 model_idle_timeout_s 即判挂死，抛 ModelIdleTimeout；
    - token 持续吐时每 _HEARTBEAT_S 秒推一条「<label> 生成中…」心跳（含已生成字数）。
    返回聚合后的 AIMessage（含 tool_calls / usage_metadata，与 ainvoke 结果同形）。"""
    idle_s, first_s = settings.model_idle_timeout_s, settings.model_first_token_timeout_s
    agg = None
    last_beat = time.monotonic()
    stream = chat.astream(messages)
    it = stream.__aiter__()
    try:
        while True:
            try:
                chunk = await wait_for(it.__anext__(), timeout=first_s if agg is None else idle_s)
            except StopAsyncIteration:
                break
            except AsyncTimeoutError as e:
                raise ModelIdleTimeout() from e
            agg = chunk if agg is None else agg + chunk
            now = time.monotonic()
            if label and now - last_beat >= _HEARTBEAT_S:
                last_beat = now
                await publish_event(getattr(ctx, "redis", None), getattr(ctx, "run_id", None),
                                    {"kind": "heartbeat", "label": f"{label} 生成中…", "chars": _grown_chars(agg)})
    finally:
        aclose = getattr(stream, "aclose", None)   # 超时/异常即刻关流，尽快释放挂死连接（不等 GC）
        if aclose is not None:
            try:
                await aclose()
            except Exception:  # noqa: BLE001 关流 best-effort
                pass
    # 正常结束但零 token（软拒答/内容过滤）不是挂死——回空消息，让上层按"未提交"优雅放弃，
    # 不误判成 ModelIdleTimeout（那会触发无谓降级、且异常类型与旧 ainvoke 路径不一致）。
    return agg if agg is not None else AIMessageChunk(content="")


async def forced_stream_submit(ctx, messages, submit, tool_name: str, label: str | None):
    """强制 submit 工具的流式调用 + 空闲超时降级重试：
    主模型流式；连续空闲超时 → 推「超时切换」事件 + 换降级模型（模型链第 2 项，缺省则同模型）再试一次；
    降级仍空闲超时 → 推失败事件 + 记 error 日志 + 抛 ModelIdleTimeout（本节点失败，run 可重试）。
    成功即返回聚合 AIMessage（含 tool_calls），并 best-effort 记 token 用量。"""
    chain = getattr(ctx.gateway, "chain", None)
    tries = chain() if callable(chain) else [{}]                   # 无 chain（异常/桩装配）：单模型无降级
    tries = [tries[0], tries[1] if len(tries) > 1 else tries[0]]   # [主, 降级]
    for i, it in enumerate(tries):
        base = ctx.gateway.get_chat(
            provider=it.get("provider"), model=it.get("model"),
            base_url=it.get("base_url"), api_key=it.get("api_key"), stream_usage=True,
        )
        chat = base.bind_tools([submit], tool_choice=tool_name)   # bind 后是 RunnableBinding，无 model_name
        t0 = time.monotonic()
        if _model_key(it) in _NO_STREAM_SUBMIT:
            msg = await chat.ainvoke(messages)   # 已知思考模型：直接非流式，不再撞 400
        else:
            try:
                msg = await astream_collect(chat, messages, ctx, label)
            except ModelIdleTimeout:
                if i == 0:
                    await publish_phase(ctx, f"{label or tool_name}·模型超时，切换重试")
                    continue
                await publish_phase(ctx, f"{label or tool_name}·重试仍超时，本轮失败")
                logger.error("model idle timeout (both tries) tool=%s label=%s", tool_name, label)
                raise
            except Exception as e:  # noqa: BLE001 仅接管"思考模型不支持流式强制提交"的 400，其余原样抛
                if not _is_thinking_toolchoice_error(e):
                    raise
                _NO_STREAM_SUBMIT.add(_model_key(it))   # 记住此模型，后续直接 ainvoke
                logger.info("思考模型不支持流式强制 tool_choice → 回退 ainvoke（model=%s）", it.get("model"))
                msg = await chat.ainvoke(messages)
        _warn_if_no_usage(msg, it)   # 流式用量依赖服务商回 include_usage；缺失=0 token 静默漏计费，先示警
        record_ctx_usage(ctx, msg, node="agent", provider=it.get("provider"),
                         model=getattr(base, "model_name", None) or it.get("model"),
                         latency_ms=int((time.monotonic() - t0) * 1000))
        return msg


def _warn_if_no_usage(msg, it: dict) -> None:
    """成功调用却抽不到 token 用量（服务商未回流式 usage）→ 记 warning，避免"0 token"静默漏计费。
    默认 deepseek/qwen 均支持 include_usage；主要防自建端点（spec319.1）忽略 stream_options。"""
    u = extract_usage(msg)
    if u["input"] == 0 and u["output"] == 0:
        logger.warning("流式调用无 token 用量（provider=%s model=%s 可能未回 include_usage）→ 本次记 0，"
                       "请核对该端点是否支持 stream_options.include_usage", it.get("provider"), it.get("model"))
