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


def _is_transient_stream_error(e: Exception) -> bool:
    """网络层瞬断（对端掐流/连接重置/服务器断开）——非模型语义错误，重试大概率成功。
    生产实测两例：92 块并行读标中单路被掐（httpx 'peer closed connection without sending
    complete message body (incomplete chunked read)'），一轮异常炸掉整个 gather、几十轮成功全作废。
    按错误文案匹配（httpx/openai 各版本异常类不稳定，文案稳定），并入降级重试通道。"""
    s = str(e).lower()
    return any(k in s for k in (
        "peer closed connection", "incomplete chunked read", "connection reset",
        "server disconnected", "connection aborted", "remote protocol error",
    ))


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
    """强制 submit 工具的调用（每模型思考开关驱动，配置说了算，不靠捕错猜）：
    - 思考关（默认）：get_chat 下发关闭思考参 → 流式 + 空闲超时（连续无 token → 换降级模型再试，
      降级仍超时则推失败事件 + 记 error + 抛 ModelIdleTimeout，本节点失败可重试）；块内心跳。
    - 思考开：思考模式与流式强制 tool_choice 不兼容 → 该模型走非流式 ainvoke（无空闲超时，但能提交）。
    成功即返回聚合 AIMessage（含 tool_calls），并 best-effort 记 token 用量。"""
    chain = getattr(ctx.gateway, "chain", None)
    tries = chain() if callable(chain) else [{}]                   # 无 chain（异常/桩装配）：单模型无降级
    tries = [tries[0], tries[1] if len(tries) > 1 else tries[0]]   # [主, 降级]
    for i, it in enumerate(tries):
        base = ctx.gateway.get_chat(
            provider=it.get("provider"), model=it.get("model"), thinking=it.get("thinking"),
            base_url=it.get("base_url"), api_key=it.get("api_key"), stream_usage=True,
        )
        chat = base.bind_tools([submit], tool_choice=tool_name)   # bind 后是 RunnableBinding，无 model_name
        t0 = time.monotonic()
        if it.get("thinking"):
            msg = await chat.ainvoke(messages)   # 思考开：非流式提交（思考+流式强制 tool_choice 不兼容）
        else:
            try:
                msg = await astream_collect(chat, messages, ctx, label)
            except Exception as e:  # noqa: BLE001 只接管挂死/瞬断，其余（4xx 语义错误等）原样抛
                if not (isinstance(e, ModelIdleTimeout) or _is_transient_stream_error(e)):
                    raise
                kind = "超时" if isinstance(e, ModelIdleTimeout) else "网络中断"
                if i == 0:
                    await publish_phase(ctx, f"{label or tool_name}·模型{kind}，切换重试")
                    continue
                await publish_phase(ctx, f"{label or tool_name}·重试仍{kind}，本轮失败")
                logger.error("model %s (both tries) tool=%s label=%s err=%s", kind, tool_name, label, e)
                raise
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
