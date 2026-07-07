from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from agent.dedupe.engine import BASELINE_TH, STRATEGIES, DocFeatures, run_dedupe
from agent.dedupe.textsim import split_sentences, strip_baseline
from agent.parsing.media import extract_doc_meta, extract_media_hashes
from agent.parsing.parsers import parse_bytes
from agent.parsing.storage_read import read_bytes

# spec315b 契约 2：POST /dedupe 同步路由——不进 LangGraph thread、不涉任何计费概念
# （hold/settle 全在 App API），agent 只做纯算法比对。

logger = logging.getLogger(__name__)

router = APIRouter()

_DIM = Literal["text", "image", "meta", "baseline"]

# 对外只给稳定文案；原始异常（boto3/zipfile 等含存储拓扑细节）只进日志
_PARSE_FAIL_MSG = "文件解析失败，请确认为文本可读的 PDF/Word 文档"


class DedupeFile(BaseModel):
    key: str      # MinIO 对象 key（末段含扩展名，属主校验在 App API）
    label: str    # 展示名，pairs 里的 a/b 用它


class DedupeBody(BaseModel):
    files: list[DedupeFile]
    tender_key: str | None = None
    dims: list[_DIM] = ["text", "image", "meta"]
    strategy: Literal["fast", "standard", "strict"] = "standard"


def _load_doc(key: str, label: str, dims: list[str], k: int) -> DocFeatures:
    """取字节 + 解析 + 按需抽特征（句子/图片指纹/文档属性）。同步函数，路由里丢线程池。"""
    data = read_bytes(key)
    parsed = parse_bytes(data, key)
    feats = DocFeatures(label=label)
    if "text" in dims:
        # 短于 shingle 窗口的句子无法比对，直接过滤（也顺带滤掉编号类噪声）
        feats.sentences = split_sentences(parsed.clauses, min_len=max(k, 6))
    if "image" in dims:
        feats.image_hashes = extract_media_hashes(data, parsed.kind)
    if "meta" in dims:
        feats.meta = extract_doc_meta(data, parsed.kind)
    return feats


def _compute(docs: list[DocFeatures], tender: DocFeatures | None,
             dims: list[str], strategy: str) -> dict:
    """O(句对) 的 CPU 重活集中在此（基线扣除 + 两两比对），由路由整段丢线程池一次，
    避免大文件把单进程 event loop 卡死（SSE 断流）。"""
    k = STRATEGIES[strategy]["k"]
    dims_run = [d for d in dims if d != "baseline"]
    if tender is not None:
        for d in docs:  # 先剔除与招标文件相似的句子（法定引用不算抄），再进入两两比对
            d.sentences, d.baseline_removed = strip_baseline(
                d.sentences, tender.sentences, k, BASELINE_TH)
        dims_run.append("baseline")
    result = run_dedupe(docs, dims_run, strategy)
    result["dims_run"] = dims_run
    return result


@router.post("/dedupe")
async def dedupe(body: DedupeBody):
    """多份投标文件围标自查：仅本次上传的 2-3 份文件两两比对（可选招标文件基线扣除），
    非全网/非历史库。解析失败某文件 → 422 {error, file}；文件数不合法 → 400。"""
    if not 2 <= len(body.files) <= 3:
        return JSONResponse({"error": "查重需要 2-3 份投标文件"}, status_code=400)
    k = STRATEGIES[body.strategy]["k"]
    docs: list[DocFeatures] = []
    for f in body.files:
        try:
            docs.append(await asyncio.to_thread(_load_doc, f.key, f.label, body.dims, k))
        except Exception:  # noqa: BLE001 解析/取件失败都算该文件不可用
            logger.exception("dedupe 文件解析失败 key=%s label=%s", f.key, f.label)
            return JSONResponse({"error": _PARSE_FAIL_MSG, "file": f.label}, status_code=422)
    tender: DocFeatures | None = None
    if "baseline" in body.dims and body.tender_key:
        try:
            tender = await asyncio.to_thread(_load_doc, body.tender_key, "招标文件", ["text"], k)
        except Exception:  # noqa: BLE001
            logger.exception("dedupe 招标文件解析失败 key=%s", body.tender_key)
            return JSONResponse({"error": _PARSE_FAIL_MSG, "file": "招标文件"}, status_code=422)
    return await asyncio.to_thread(_compute, docs, tender, body.dims, body.strategy)
