"""spec 2026-08-08-library-pdf-pages:agent 工具路由(mock storage,不连 MinIO)。"""
from agent.routes import pdf_pages as mod
from agent.routes.pdf_pages import PdfPagesBody, pdf_pages


class _Storage:
    def __init__(self, pdf: bytes):
        self.pdf = pdf
        self.puts: list[tuple[str, bytes, str]] = []

    async def read_bytes(self, key):
        return self.pdf

    async def put_bytes(self, key, data, content_type="application/octet-stream"):
        self.puts.append((key, data, content_type))


def _pdf_with_pages(n: int) -> bytes:
    import io

    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument.new()
    for _ in range(n):
        doc.new_page(595, 842)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


async def test_renders_uploads_and_returns_page_keys(monkeypatch):
    store = _Storage(_pdf_with_pages(2))
    monkeypatch.setattr(mod, "storage", store)
    resp = await pdf_pages(PdfPagesBody(key="uploads/u1/f1/cert.pdf"))
    assert [p["key"] for p in resp["pages"]] == [t[0] for t in store.puts]
    assert len(resp["pages"]) == 2
    assert all(k.startswith("derived/") and k.endswith(".png") for k, _, _ in
               [(p["key"], 0, 0) for p in resp["pages"]])
    assert all(ct == "image/png" for _, _, ct in store.puts)
    assert resp["pages"][0]["key"].endswith("page-1.png")
    assert 1595 <= resp["pages"][0]["width"] <= 1605 and resp["pages"][0]["height"] > 1600


async def test_too_many_pages_is_422(monkeypatch):
    from fastapi.responses import JSONResponse
    store = _Storage(_pdf_with_pages(6))
    monkeypatch.setattr(mod, "storage", store)
    resp = await pdf_pages(PdfPagesBody(key="uploads/u1/f1/manual.pdf"))
    assert isinstance(resp, JSONResponse) and resp.status_code == 422
    assert b"too_many_pages" in resp.body
    assert store.puts == [], "超页数不该有任何对象写入"


async def test_unrenderable_is_422(monkeypatch):
    from fastapi.responses import JSONResponse
    store = _Storage(b"broken bytes")
    monkeypatch.setattr(mod, "storage", store)
    resp = await pdf_pages(PdfPagesBody(key="uploads/u1/f1/broken.pdf"))
    assert isinstance(resp, JSONResponse) and resp.status_code == 422
    assert b"unrenderable" in resp.body


def test_router_is_mounted():
    """接线必须是真的(本项目"写了但没接上"翻过多次车)。"""
    from agent.app import create_app
    app = create_app()
    paths = set()
    for route in app.routes:
        if type(route).__name__ == '_IncludedRouter' and hasattr(route, 'original_router'):
            for r in route.original_router.routes:
                if hasattr(r, 'path'):
                    paths.add(r.path)
    assert "/tools/pdf-pages" in paths
