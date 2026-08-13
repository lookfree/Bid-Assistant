"""原始 .doc 里被格式转换弄丢的内嵌图（转换丢图兜底）。

2026-08-14 生产实测（《响应文件.doc》）：授权书页四张证件图排版一模一样，转成 docx 后只剩
三张——法定代表人人像面在转换中消失（丢图原因在转换器内部，不受我们控制）。丢图直接导致
审查报「身份证正反面是否齐全无法核验」，而用户文件里明明有：OCR 与审查每一环都没错，
唯独转换偷吃了一张图，字节级对比才挖出来。

兜底思路：转换后在**原始 .doc 字节**里按图片魔数（PNG/JPEG）把可解码的图都抠出来，
与转换产物做**像素级**比对——转换器会重编码 JPEG（字节差几十），字节哈希对不上，
16×16 灰度指纹按平均差判同图。凡「原文件有、转换没保留」的图交还识别链路补送，
识别文字挂正文末尾并注明来源（见 ocr.ocr_docx_images）。
已知留白：EXIF 内嵌缩略图会让魔数扫描截错 JPEG 边界，那一块解不开就被跳过——
兜底少救一张，不伤主链路（整套兜底本就是 best-effort）。
"""
from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

# 参与比对/兜底的最小像素面积（与 ocr._MIN_IMAGE_PIXELS 同一个道理的口径）：
# 对任意二进制按魔数扫，会扫出大量图标/装饰碎块，证照类扫描图没有这么小的。
_MIN_PIXELS = 300 * 300
# 兜底张数帽：正常转换丢图是个位数；嵌着图库的怪文件能扫出成百上千块，
# 超帽只取前若干张并记日志，绝不让兜底反客为主吃光识别预算。
_MAX_LOST = 20
# 16×16 灰度指纹的平均绝对差阈值：同一张图经转换器重编码，差在 0~3 的量级；
# 不同的两张证照/报表差远大于 20。取 8——重编码不误杀、异图不误配。
_MAX_AVG_DIFF = 8


def _gray16(data: bytes) -> list[int] | None:
    """一张图 → 16×16 灰度指纹（解不开/太小 → None，不参与比对）。"""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.width * im.height < _MIN_PIXELS:
                return None
            return list(im.convert("L").resize((16, 16)).getdata())
    except Exception:  # noqa: BLE001 魔数扫出来的本就可能是碎块，解不开＝不算图
        return None


def _same(a: list[int], b: list[int]) -> bool:
    """两枚指纹是不是同一张图（平均绝对差口径，见 _MAX_AVG_DIFF）。"""
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a) <= _MAX_AVG_DIFF


def raw_doc_images(data: bytes) -> list[bytes]:
    """原始 .doc 字节里按魔数抠出的、解得开且够大的 PNG/JPEG 块。"""
    out: list[bytes] = []
    for head, tail, extra in ((b"\x89PNG\r\n\x1a\n", b"IEND", 8),
                              (b"\xff\xd8\xff", b"\xff\xd9", 2)):
        i = 0
        while True:
            p = data.find(head, i)
            if p < 0:
                break
            e = data.find(tail, p + len(head))
            if e < 0:
                break
            blob = data[p:e + extra]
            if _gray16(blob) is not None:
                out.append(blob)
            i = e + extra
    return out


def lost_images(raw: bytes, kept: list[bytes]) -> list[bytes]:
    """原文件里有、转换产物里按像素指纹找不到的图（兜底集合内部同图去重）。"""
    kept_fps = [fp for k in kept if (fp := _gray16(k)) is not None]
    lost: list[bytes] = []
    lost_fps: list[list[int]] = []
    for blob in raw_doc_images(raw):
        fp = _gray16(blob)
        if fp is None or any(_same(fp, f) for f in kept_fps + lost_fps):
            continue
        lost.append(blob)
        lost_fps.append(fp)
        if len(lost) >= _MAX_LOST:
            logger.warning("转换丢图超过兜底帽 %d 张，只补前 %d 张", _MAX_LOST, _MAX_LOST)
            break
    return lost
