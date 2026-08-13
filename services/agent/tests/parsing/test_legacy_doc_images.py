"""转换丢图兜底（2026-08-14 生产实测：《响应文件.doc》授权书页四张证件图，
LibreOffice 转换后只剩三张——法定代表人人像面消失，审查因此报「身份证是否齐全无法核验」，
而用户文件里明明有）。原始 .doc 按魔数扫图 + 16×16 灰度指纹比对找出转换没保留的图。"""
import io

from agent.parsing.legacy_doc_images import lost_images, raw_doc_images


def _pattern(seed: int, w: int = 400, h: int = 400, fmt: str = "PNG") -> bytes:
    """一张棋盘图。seed 不同 → 图案互反 → 指纹差最大化；纯色图会在灰度指纹上互相撞车
    （white 与 ivory 的灰度只差 1），拿它测比对等于没测。"""
    from PIL import Image

    im = Image.new("L", (w, h), 255)
    px = im.load()
    for x in range(w):
        for y in range(h):
            if ((x // 40) + (y // 40) + seed) % 2:
                px[x, y] = 0
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format=fmt, quality=90)
    return buf.getvalue()


def test_raw_scan_finds_decodable_images_inside_ole_bytes():
    """.doc 是 OLE 复合文件，图以原始字节内嵌——按 PNG/JPEG 魔数抠，PIL 解得开才算数。"""
    raw = (b"\xd0\xcf\x11\xe0" + b"\x00" * 128 + _pattern(0) + b"junk-between"
           + _pattern(1, fmt="JPEG") + b"\x00" * 64)
    found = raw_doc_images(raw)
    assert len(found) == 2
    assert found[0].startswith(b"\x89PNG") and found[1].startswith(b"\xff\xd8\xff")


def test_tiny_decor_blobs_are_ignored():
    """图标/装饰碎块（面积不足）不参与兜底：证照类扫描图没有这么小的。"""
    raw = b"\x00" * 32 + _pattern(0, w=120, h=120) + b"\x00" * 32
    assert raw_doc_images(raw) == []


def test_a_reencoded_survivor_is_not_reported_lost():
    """转换器会重编码 JPEG（字节变了几十个）：字节哈希对不上，但像素指纹必须认出是同一张图
    ——认不出的话每份 .doc 都会把幸存的图再补送一遍，识别文字整段重复。"""
    src = _pattern(0)
    reencoded = io.BytesIO()
    from PIL import Image

    with Image.open(io.BytesIO(src)) as im:
        im.convert("RGB").save(reencoded, format="JPEG", quality=60)
    raw = b"\xd0\xcf\x11\xe0" + src
    assert lost_images(raw, [reencoded.getvalue()]) == []


def test_a_dropped_image_is_reported_lost_once():
    """真丢的图要报出来；.doc 里存了两份同一张的（重复贴图形态）只报一次。"""
    survivor, dropped = _pattern(0), _pattern(1)
    raw = b"\xd0\xcf\x11\xe0" + survivor + b"\x00" * 16 + dropped + b"\x00" * 16 + dropped
    lost = lost_images(raw, [survivor])
    assert lost == [dropped]
