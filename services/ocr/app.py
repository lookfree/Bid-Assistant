"""本地 OCR 服务（客户验证环境）。

为什么本地而不是云 OCR：客户不允许业务数据出内网——发过去的会是营业执照、法人身份证、
资质证书这类东西。（230 实测云 OCR 端点其实可达，是合规上不允许，不是网络不通。）

为什么独立容器而不是塞进 agent：OCR 是 CPU 尖峰负载，agent 是跑长任务的 asyncio 进程，
两者同进程会互相抢核——本仓栽过一次同类跟头（model_stream 的 O(n²) 解析烧满单核，
症状表现成"模型变慢"，排查了很久）。独立容器可单独限额、单独扩缩。

为什么 RapidOCR 而不是 PaddleOCR：同源模型、同等中文识别质量，但走 ONNXRuntime，
不拖进整个 paddle 运行时——镜像小一个量级，纯 CPU 即可（两台机都无 GPU）。

231 实测（12C/32G，容器限 3 核 3G、OCR_THREADS=2）：
  模型加载 0.8s（仅首次）· 单张 1200×850 识别 0.71–0.90s
  推理中内存 113–244 MiB · CPU 205%（卡在 2 线程上，没有失控吃满 12 核）
"""
import io
import logging
import os
from typing import Literal

from fastapi import FastAPI, Response
from pydantic import BaseModel, Field

logger = logging.getLogger("ocr")

# 线程数必须设死：ONNXRuntime 默认吃满所有核，一次识别就能把 16 核占光，
# 与同机的 agent/api 抢资源。这里限住，容器层再叠一道 cpus 限额。
_THREADS = int(os.environ.get("OCR_THREADS", "2"))
# 单次请求的图片体积上限（字节）：正文插图前端已压到 ≤1200px JPEG，正常在 300KB 内。
_MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(8 * 1024 * 1024)))

app = FastAPI(title="ocr")
_engine = None


@app.on_event("startup")
def _load() -> None:
    global _engine
    from rapidocr_onnxruntime import RapidOCR

    # 首次启动从包内自带模型加载（RapidOCR 的 onnx 权重随 wheel 分发，约 15MB，
    # 不必联网下载——客户环境不能依赖运行时拉模型）。
    _engine = RapidOCR(intra_op_num_threads=_THREADS, inter_op_num_threads=_THREADS)
    logger.info("OCR engine ready, threads=%s", _THREADS)


@app.get("/health")
def health(response: Response):
    if _engine is None:
        response.status_code = 503
        return {"status": "loading"}
    return {"status": "ok", "threads": _THREADS}


class OcrRequest(BaseModel):
    """image: 图片的 base64（可带 data:image/...;base64, 前缀）。

    mode: 识别行怎么拼成文本。
      · text（默认，**旧口径不变**）——空格拼成一行。调用方是 App 侧的正文插图识别：
        一张小图配一句 alt 文字，行结构没有意义。
      · lines——按行换行拼。调用方是 agent 侧的整页扫描件识别：那是一整页表格/条目，
        拼成一行后审查再也判不出「★条款有没有逐条登进偏离表」这类**按行**的结论。
    旧版服务收到 mode 会原样忽略（pydantic 默认丢弃多余字段）→ 退回一行文本，不报错。
    """

    image: str = Field(..., min_length=16)
    max_chars: int = Field(default=400, ge=1, le=5000)
    mode: Literal["text", "lines"] = "text"


def _join(lines: list[str], mode: str) -> str:
    """识别行 → 文本（口径见 OcrRequest.mode）。整页扫描件按行拼才留得住表格/条目的行结构。"""
    return ("\n" if mode == "lines" else " ").join(lines).strip()


def _decode(image: str) -> bytes:
    import base64

    raw = image.split(",", 1)[1] if image.startswith("data:") else image
    data = base64.b64decode(raw, validate=False)
    if len(data) > _MAX_BYTES:
        raise ValueError(f"图片过大（{len(data)} 字节，上限 {_MAX_BYTES}）")
    return data


@app.post("/ocr")
def ocr(req: OcrRequest):
    """图片 → 识别文字。识别不出内容回空串（不是错误：证照角标、装饰图本就无字）。

    调用方拿到文字后写进 <img alt>，审查侧的 strip_inline_images 会把 alt 透出给模型，
    于是「［图片：营业执照.png］」变成「［图片：营业执照.png｜统一社会信用代码 913100…］」。
    """
    if _engine is None:
        return Response(status_code=503, content='{"error":"engine_loading"}', media_type="application/json")
    try:
        data = _decode(req.image)
    except ValueError as e:
        return Response(status_code=400, content=f'{{"error":"{e}"}}', media_type="application/json")
    except Exception:
        return Response(status_code=400, content='{"error":"图片解码失败"}', media_type="application/json")

    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:
        import numpy as np

        arr = np.array(im.convert("RGB"))
    result, _elapse = _engine(arr)
    # RapidOCR 返回 [[框, 文字, 置信度], ...]；置信度过低的丢掉（证照上的花纹常被误识成字符）
    lines = [t for _box, t, score in (result or []) if t and score >= 0.5]
    text = _join(lines, req.mode)
    return {"text": text[: req.max_chars], "lines": len(lines)}
