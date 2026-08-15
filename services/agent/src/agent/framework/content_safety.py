"""输出内容敏感词扫描：备案「违法不良信息识别与发现机制」的机器侧。

默认口径仍是只识别记录、不拦截不改文（与 export 节点上跑了半年的那份一致）。
ContentSafetyHook 把同一套扫描搬到轮次钩子上，多出来的只有 block 模式——
框架有了否决信号之后才谈得上这个模式，在那之前这套扫描只能硬接进具体节点里。
"""
from __future__ import annotations

import asyncio
import logging
from functools import lru_cache
from pathlib import Path

from agent.config import settings
from agent.framework.hooks import FAIL, IGNORE, TurnView, ValidatingHook

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def load_words() -> frozenset[str]:
    """词库：settings.sensitive_words_path 优先，否则包内默认文件。每行一词，# 注释与空行跳过。"""
    path = (Path(settings.sensitive_words_path) if settings.sensitive_words_path
            else Path(__file__).parent / "sensitive_words.txt")
    words = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        w = line.strip()
        if w and not w.startswith("#"):
            words.add(w.lower())
    return frozenset(words)


def scan_text(text: str) -> dict[str, int]:
    """子串计数扫描（词库百量级，直扫够用）。英文词忽略大小写。返回 {词: 次数}，无命中空 dict。"""
    lowered = text.lower()
    hits = {word: count for word in load_words() if (count := lowered.count(word)) > 0}
    return hits


DENY_MESSAGE = "本次生成的内容未通过合规校验，已终止输出。请调整表述后重试。"


class ContentSafetyHook(ValidatingHook):
    """轮次输出侧的敏感词校验。校验钩子——只看模型说了什么，不改它。

    block=False（默认）：命中只落一条 content_flag 事件，照常放行。与既有口径一致。
    block=True：命中即否决这一轮，用 DENY_MESSAGE 顶掉模型输出。

    failure_policy 跟着模式走，这是这个钩子最该抄 K8s 的一点：
    只记录的时候扫描挂了无所谓（Ignore），一旦它变成拦截器，扫描挂了就必须让整轮失败（Fail）——
    否则扫描器一崩，拦截静默消失，而配置里还写着「已开启拦截」。
    """

    def __init__(self, run_ctx=None, *, block: bool = False):
        self._run_ctx = run_ctx
        self._block = block
        self.failure_policy = FAIL if block else IGNORE

    async def post_invoke(self, view: TurnView) -> None:  # type: ignore[override]
        text = getattr(view.result, "content", None)
        if not isinstance(text, str) or not text:
            return                                   # 工具调用轮没有正文，跳过
        hits = scan_text(text)
        if not hits:
            return
        await self._record(hits)
        if self._block:
            view.deny(DENY_MESSAGE)

    async def _record(self, hits: dict[str, int]) -> None:
        """落一条 content_flag。埋点写失败不算扫描失败——拦截模式下也不该因为 PG 断连就整轮报错。"""
        ctx = self._run_ctx
        if ctx is None or getattr(ctx, "recorder", None) is None:
            return
        try:
            await asyncio.to_thread(
                ctx.recorder.log_event, ctx.run_id, ctx.agent_type, "content_flag",
                node="agent", level="warn",
                data={"words": sorted(hits), "counts": hits, "blocked": self._block},
                thread_id=getattr(ctx, "thread_id", None),
            )
        except Exception:  # noqa: BLE001 观测写入 best-effort
            logger.warning("敏感词命中事件落库失败", exc_info=True)
