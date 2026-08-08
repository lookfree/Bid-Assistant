"""模型输入预算：一次调用能喂多少字，由窗口减出来，而不是写死一个常量。

2026-08-08 生产事故：述标把整本标书原样喂出去，端点回 400——
「requested 32768 output tokens and your prompt contains at least 98305 input
tokens, for a total of at least 131073 tokens」，超窗口 **1 个 token**，整步失败退款。
述标此前一行长度限制都没有，大标书是必炸而不是偶发。

写死常量为什么不行：预算里不止正文，系统提示、工具 schema、读标结论都在同一条消息里，
而读标结论的大小随招标文件浮动（实测中位 17810 tokens，最大 197002）。
拿固定值去砍正文，要么砍不够（照样 400），要么砍过头——实测中位项目本来放得下
4.7 万 tokens 的正文，一刀切到 4 万字（约 3.5 万 tokens）等于平白丢掉一半内容。
"""
from __future__ import annotations

import logging
import re

from agent.models.errors import _chain_text

logger = logging.getLogger(__name__)

__all__ = ["estimate_tokens", "chapter_budget", "is_context_overflow", "run_with_shrink",
           "DEFAULT_CONTEXT_WINDOW"]

# 端点未告知窗口时的兜底。131072 = 128K，取自客户环境 vLLM 的 --max-model-len。
# 正式来源是运营后台的模型配置（contextWindow），这里只在配置缺失时兜底。
DEFAULT_CONTEXT_WINDOW = 131_072

# 中文与非中文分开估：2026-08-08 用一次真实 400 标定——126409 字符（中文 107033）
# 被端点算成 98305 tokens，即中文约 1.15 字/token、其余约 4 字符/token。
# **保守取整**：中文按 1 字 1 token 算（比实测的 0.87 高 15%），宁可少喂也不要再撞 400。
_CJK = re.compile(r"[　-鿿＀-￯]")
_ASCII_CHARS_PER_TOKEN = 4.0


def estimate_tokens(text: str) -> int:
    """估算一段文本的 token 数。宁高勿低——低估的代价是整步失败。"""
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    return int(cjk + (len(text) - cjk) / _ASCII_CHARS_PER_TOKEN)


# 后台没配 max_tokens 时预留给输出的量，取 App 侧 DEFAULT_PARAMS.maxTokens。
_DEFAULT_OUTPUT_RESERVE = 8_192
# 工具 schema（字段描述、约束文字）也在输入里，但它不经过我们拼的字符串，估不到。
# 实测各步的提交 schema 在数千 token 量级，留 8000 打底。
_SCHEMA_RESERVE_TOKENS = 8_000
# 再留一成给估算误差本身：换模型、换网关，字/token 的系数就变。
_SAFETY_RATIO = 0.9
# 正文再挤也要留的下限：低于这个数不如直接失败——喂几千字进去出来的审查结论没有意义，
# 用户却照样付费。节点据此当场失败退款，而不是硬塞一个下限、再把三轮收缩重试全烧在
# 一个注定装不下的载荷上（收缩只动正文，而这种情况下超额的是固定部分，缩多少轮都没用）。
MIN_CHAPTER_TOKENS = 4_000


def chapter_budget(fixed_text: str, *, context_window: int | None, max_tokens: int | None) -> int:
    """留给正文的 token 额度 = 窗口 − 输出配额 − 固定部分 − schema − 安全余量。

    fixed_text：这条消息里除正文以外的所有内容（系统提示 + 读标结论 + 各类约束文字）。
    context_window / max_tokens 缺省时取兜底值——**宁可按小窗口算**，算小了只是喂少点，
    算大了是 400。
    """
    window = context_window or DEFAULT_CONTEXT_WINDOW
    # 没配 max_tokens 不等于不产出——模型照样能一路生成到窗口上限。按 App 侧的默认值预留，
    # 预留 0 会把整个窗口都当成输入额度，输出一长就又是 400。
    reserved_out = max_tokens or _DEFAULT_OUTPUT_RESERVE
    left = window - reserved_out - estimate_tokens(fixed_text) - _SCHEMA_RESERVE_TOKENS
    return max(int(left * _SAFETY_RATIO), 0)


# 端点报"输入太长"的说法各家不一。只认一家就等于没兜底——换个网关又是整步失败。
_OVERFLOW_MARKS = (
    "maximum context length",       # OpenAI / vLLM
    "context length",
    "context_length_exceeded",
    "reduce the length of the",     # "…of the input prompt / messages"
    "too many tokens",
    "input is too long",
    "prompt is too long",
)


def is_context_overflow(e: BaseException) -> bool:
    """这次失败是不是"输入超出窗口"。

    沿 __cause__/__context__ 链下钻（本仓韧性铁律）：openai SDK 会把真因包一层，
    只看 str(顶层) 认不出来。
    """
    return any(m in _chain_text(e).lower() for m in _OVERFLOW_MARKS)


# 撞上超限后依次用的预算折扣。估算永远有偏差——换模型、换网关，字/token 的系数就变；
# 与其把精度赌在估算上，不如撞上了就砍半重来。三次仍不行才认输（那多半不是长度问题）。
_SHRINK_STEPS = (1.0, 0.5, 0.25)


async def run_with_shrink(build_and_run, *, label: str = ""):
    """跑一次调用；若因输入超窗口失败，就把预算打折重建载荷再试。

    build_and_run(factor) 按给定折扣重建输入并发起调用——**必须重建**，
    拿同一条消息重试没有任何意义，只是再烧一次钱。
    """
    last: BaseException | None = None
    for factor in _SHRINK_STEPS:
        try:
            return await build_and_run(factor)
        except Exception as e:  # noqa: BLE001
            if not is_context_overflow(e):
                raise
            last = e
            logger.warning("%s 按 %.0f%% 预算仍超出模型窗口，缩小后重建重试", label, factor * 100)
    raise last  # type: ignore[misc]
