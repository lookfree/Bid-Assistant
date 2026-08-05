"""模型调用失败 → 运营看得懂的中文说明。

后台「模型管理」的测试连通/拉取模型此前把上游报文原样吐到界面上，例如：
  Error code: 503 - {'error': {'code': 'model_not_found', 'message': 'No available channel
  for model test under group Business-gpt (distributor) (request id: 2026080510461610...)'}}
运营既看不出「是模型名不存在」，也不知道该改哪一栏。

两条原则：
- **说清是什么问题 + 该改哪里**，而不是只翻译名词；
- **保留原文**：真排查时那串 request id 往往是找服务商对账的唯一线索，翻译不能把它吃掉。
"""
from __future__ import annotations

import re

_RAW_KEEP = 200          # 附在中文说明后的原文长度上限（界面上是一小块红字）
_MAX_LEN = 400           # 整体上限

# 状态码只从「Error code: 503」这类位置取，不在全文里裸搜数字：上游报文带的 request id
# 是长数字串（如 20260805104016429503888），裸搜会把「模型名不存在」误判成「密钥无效」，
# 运营会去改一把本来正确的密钥。
_STATUS_RE = re.compile(r"(?:error code|status code|status|http)\W{0,3}(\d{3})\b")

_STATUS_CN: dict[str, str] = {
    "401": "API Key 无效或已失效：请核对密钥是否填错、是否已在服务商处被禁用",
    "403": "API Key 没有调用该模型的权限：请在服务商控制台确认该密钥已开通此模型",
    "404": "接口地址不对：请核对 Base URL 是否带上了 /v1 这类路径前缀",
    "429": "调用过于频繁或额度不足：请稍后重试，或在服务商处确认账户余额/限流配额",
    "400": "请求被服务商拒绝（参数不合法）：请检查模型名与采样参数（temperature / max_tokens / top_p）",
    "500": "服务商侧暂时不可用（上游返回 5xx）：通常与我们的配置无关，请稍后重试",
    "502": "服务商侧暂时不可用（上游返回 5xx）：通常与我们的配置无关，请稍后重试",
    "503": "服务商侧暂时不可用（上游返回 5xx）：通常与我们的配置无关，请稍后重试",
    "504": "服务商侧暂时不可用（上游返回 5xx）：通常与我们的配置无关，请稍后重试",
}

# 关键词判据按「先具体、后笼统」排列，且**先于状态码**判定：网关把「模型名不存在」包装成
# 503 的情形很常见（实测那条就是 503 + model_not_found），只看状态码会答非所问。
_RULES: list[tuple[tuple[str, ...], str]] = [
    (("model_not_found", "model not found", "no available channel", "does not exist",
      "unknown model", "invalid model"),
     "模型名不存在或该密钥下不可用：请核对「模型名」是否与服务商控制台里的一致（可点「拉取可用模型」从服务端取回真实列表）"),
    (("unauthorized", "invalid api key", "incorrect api key", "invalid_api_key",
      "authentication", "api key not valid"),
     "API Key 无效或已失效：请核对密钥是否填错、是否已在服务商处被禁用"),
    (("forbidden", "permission", "no permission", "access denied"),
     "API Key 没有调用该模型的权限：请在服务商控制台确认该密钥已开通此模型"),
    (("rate limit", "rate_limit", "too many requests", "quota", "insufficient"),
     "调用过于频繁或额度不足：请稍后重试，或在服务商处确认账户余额/限流配额"),
    (("timeout", "timed out", "read timeout"),
     "连接服务商超时：请确认 Base URL 可达、网络通畅（自建端点还要确认服务已启动）"),
    (("connection error", "connection refused", "failed to establish", "name or service not known",
      "getaddrinfo", "network is unreachable", "ssl", "certificate"),
     "连不上该地址：请核对 Base URL（含端口与 /v1 路径），并确认该地址从服务器侧可访问"),
    (("bad gateway", "service unavailable", "internal server error"),
     "服务商侧暂时不可用（上游返回 5xx）：通常与我们的配置无关，请稍后重试"),
    (("bad request",),
     "请求被服务商拒绝（参数不合法）：请检查模型名与采样参数（temperature / max_tokens / top_p）"),
]


def _chain_text(e: BaseException) -> str:
    """沿 __cause__/__context__ 链拼全文再判定——真因常被 SDK 包一层，
    str(顶层) 可能只有 "Connection error."（本仓韧性铁律）。"""
    parts: list[str] = []
    seen: set[int] = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        parts.append(str(cur))
        cur = cur.__cause__ or cur.__context__
    return " ".join(parts)


def friendly_model_error(e: BaseException) -> str:
    """异常 → 「中文说明（原始报错：…）」。认不出的错误只回原文，不编造原因。"""
    raw = _chain_text(e).strip()
    low = raw.lower()
    hint = next((cn for keys, cn in _RULES if any(k in low for k in keys)), None)
    if hint is None:   # 关键词认不出，再退而求其次看状态码
        m = _STATUS_RE.search(low)
        hint = _STATUS_CN.get(m.group(1)) if m else None
    if hint is None:
        return raw[:_MAX_LEN]
    return f"{hint}（原始报错：{raw[:_RAW_KEEP]}）"[:_MAX_LEN]
