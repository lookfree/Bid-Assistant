from __future__ import annotations

import io
import logging
import xml.etree.ElementTree as ET
import zipfile

# spec315b 契约 1：docx 图片 dHash + 文档属性抽取（独立函数，不动 ParsedDoc 既有形状）

logger = logging.getLogger(__name__)

_MEDIA_PREFIX = "word/media/"
_APP_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}"

# 图片解码资源预算：单图像素上限（Pillow 默认要 >1.78 亿像素才拒，过宽）+ 每文档最多参与
# 指纹的图片数，超预算跳过并记日志——防恶意/超大文档把解码线程拖垮。
_MAX_IMAGE_PIXELS = 50_000_000
_MAX_IMAGES_PER_DOC = 24


def dhash64(img) -> int:
    """Pillow 图像 → 64 位 dHash（差值哈希）：灰度缩至 9×8，逐行比较相邻像素亮度。
    对缩放/轻度压缩稳健，适合「同一张资质图片被多份标书复用」的围标特征检测。"""
    from PIL import Image

    g = img.convert("L").resize((9, 8), Image.LANCZOS)
    px = g.tobytes()   # L 模式行主序原始字节，逐像素可索引（getdata 在 Pillow 12.3 已废弃）
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (1 if px[row * 9 + col] > px[row * 9 + col + 1] else 0)
    return bits


def hamming(a: int, b: int) -> int:
    """两个 64 位哈希的汉明距离（不同比特数）。"""
    return (a ^ b).bit_count()


def extract_media_hashes(data: bytes, kind: str) -> list[int]:
    """docx 内嵌图片 → dHash 列表：解压 word/media/ 下所有图片逐一哈希。
    Pillow 打不开的矢量格式（emf/wmf 等）跳过不阻断；pdf 图片抽取 v1 不做（spec315b 决策记录）。
    资源预算：单图 ≤ _MAX_IMAGE_PIXELS 像素、每文档最多 _MAX_IMAGES_PER_DOC 张，超出跳过记日志。"""
    if kind != "docx":
        return []
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = _MAX_IMAGE_PIXELS  # 解码兜底：超限图 open/decode 阶段即拒
    hashes: list[int] = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        media = [n for n in z.namelist() if n.startswith(_MEDIA_PREFIX)]
        for idx, name in enumerate(media):
            if len(hashes) >= _MAX_IMAGES_PER_DOC:
                logger.info("extract_media_hashes: 图片数超预算，跳过剩余 %d 张（上限 %d）",
                            len(media) - idx, _MAX_IMAGES_PER_DOC)
                break
            try:
                with Image.open(io.BytesIO(z.read(name))) as img:
                    if img.width * img.height > _MAX_IMAGE_PIXELS:
                        logger.warning("extract_media_hashes: 跳过超预算图片 %s（%d 像素）",
                                       name, img.width * img.height)
                        continue
                    hashes.append(dhash64(img))
            except Exception:  # noqa: BLE001 非位图格式/解码炸弹不阻断整体抽取
                continue
    return hashes


def _docx_company(data: bytes) -> str | None:
    """docx 的「公司」不在 core.xml 而在 docProps/app.xml（扩展属性），单独解一次。"""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if "docProps/app.xml" not in z.namelist():
                return None
            el = ET.fromstring(z.read("docProps/app.xml")).find(f"{_APP_NS}Company")
            return ((el.text or "").strip() or None) if el is not None else None
    except Exception:  # noqa: BLE001 属性缺失/损坏不视为解析失败
        return None


def extract_doc_meta(data: bytes, kind: str) -> dict:
    """文档属性抽取：docx 走 core_properties(+app.xml Company)，pdf 走 metadata。
    返回 {author, last_modified_by, company, created}，缺失为 None（查重 meta 维只认非空且相等）。"""
    meta: dict = {"author": None, "last_modified_by": None, "company": None, "created": None}
    if kind == "docx":
        from docx import Document

        cp = Document(io.BytesIO(data)).core_properties
        meta["author"] = (cp.author or "").strip() or None
        meta["last_modified_by"] = (cp.last_modified_by or "").strip() or None
        meta["company"] = _docx_company(data)
        meta["created"] = cp.created.isoformat() if cp.created else None
    elif kind == "pdf":
        from pypdf import PdfReader

        info = PdfReader(io.BytesIO(data)).metadata
        if info:
            meta["author"] = (info.author or "").strip() or None
            company = info.get("/Company")
            meta["company"] = (str(company).strip() or None) if company else None
            try:
                created = info.creation_date
                meta["created"] = created.isoformat() if created else None
            except Exception:  # noqa: BLE001 日期字段格式千奇百怪，解不出就置空
                meta["created"] = None
    return meta
