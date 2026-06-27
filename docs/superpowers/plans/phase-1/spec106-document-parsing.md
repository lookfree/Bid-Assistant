# spec106 · 文档解析（docx/pdf/xlsx） 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 横切能力（§4.4）：把 MinIO 上的招标文件（docx/pdf/xlsx）按 key 读取并解析成干净文本 + 结构（段落/表格/页数），供读标（spec107）等能力使用。提供函数 `read_and_parse(key)` 与可挂给智能体的 `parse_document` 工具。

**Architecture:** `parsers` 按类型解析字节流 → `ParsedDoc`；`storage_read` 用 boto3（S3 兼容）从 MinIO 按 key 取字节；`read_and_parse(key)` = 取 + 解析。纯 Python 解析库（python-docx/pypdf/openpyxl）。扫描件 OCR 不在 Phase 1 范围（留加固）。

**Tech Stack:** python-docx、pypdf、openpyxl、boto3、pytest（+fpdf2 仅测试生成 PDF）。

## Global Constraints

见 `spec100-index.md`。本 spec 关键约束：
- 文件只按 **key 从 MinIO 读**（App 传文件引用，不传二进制，§4.4）；bucket/凭据从 env（`.env.bidsaas.local`）。
- 解析失败要可预期报错（损坏/不支持类型），不崩服务。
- 横切能力、对业务无知；不碰钱。
- 集成测试连真 MinIO（bidsaas 桶），自清理上传的测试对象。
- 在 `main` 上先开分支；提交信息结尾附 Co-Authored-By。

---

## File Structure

```
services/agent/
├── pyproject.toml                      # 改：+ python-docx / pypdf / openpyxl / boto3（dev: fpdf2）
├── src/agent/
│   ├── config.py                       # 改：+ MINIO_* 字段
│   └── parsing/
│       ├── __init__.py
│       ├── types.py                    # 新：ParsedDoc
│       ├── parsers.py                  # 新：parse_docx/parse_pdf/parse_xlsx + parse_bytes 分发
│       ├── storage_read.py             # 新：boto3 读 MinIO 字节
│       ├── service.py                  # 新：read_and_parse(key)
│       └── tool.py                     # 新：parse_document LangChain 工具
└── tests/parsing/
    ├── test_parsers.py                 # 新：三类型解析（测试内生成文件）
    └── test_read_and_parse.py          # 新：真 MinIO 往返
```

---

## Interfaces（本 spec 对外产出，供 spec107 依赖）

- Produces：
  - `ParsedDoc`：`{ text: str, kind: str, pages: int|None, tables: list[list[list[str]]], meta: dict }`。
  - `parse_bytes(data: bytes, filename: str) -> ParsedDoc`（按扩展名分发；不支持类型抛 `UnsupportedDocument`）。
  - `read_bytes(key: str) -> bytes`（MinIO）。
  - `read_and_parse(key: str) -> ParsedDoc`。
  - `parse_document_tool` / `make_parse_tool()`（LangChain 工具：入参 key → 返回文本）。

---

## Task 1: 依赖 + 配置 + MinIO 读取

**Files:** Modify `pyproject.toml`、`src/agent/config.py`；Create `src/agent/parsing/__init__.py`、`parsing/storage_read.py`、`parsing/types.py`

- [ ] **Step 1: 开分支 + 装依赖**

```bash
cd "/Users/wuhoujin/Documents/projects/Bid Assistant"
git checkout -b phase1/spec106-doc-parsing
cd services/agent && uv add python-docx pypdf openpyxl boto3 && uv add --dev fpdf2 && mkdir -p src/agent/parsing
```

- [ ] **Step 2: `config.py` 加 MinIO 字段**

```python
    minio_endpoint: str | None = None       # 来自 MINIO_ENDPOINT
    minio_access_key: str | None = None
    minio_secret_key: str | None = None
    minio_bucket: str = "bidsaas"
    minio_region: str = "us-east-1"
```

- [ ] **Step 3: 写 `parsing/types.py`**

```python
from __future__ import annotations
from dataclasses import dataclass, field


class UnsupportedDocument(Exception):
    pass


@dataclass
class ParsedDoc:
    text: str
    kind: str                                  # docx/pdf/xlsx
    pages: int | None = None
    tables: list[list[list[str]]] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
```

- [ ] **Step 4: 写 `parsing/storage_read.py`**

```python
from __future__ import annotations
import boto3
from agent.config import settings

_client = None


def _s3():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=settings.minio_endpoint,
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            region_name=settings.minio_region,
        )
    return _client


def read_bytes(key: str) -> bytes:
    obj = _s3().get_object(Bucket=settings.minio_bucket, Key=key)
    return obj["Body"].read()


def _put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    """仅测试/工具用：上传字节。"""
    _s3().put_object(Bucket=settings.minio_bucket, Key=key, Body=data, ContentType=content_type)


def _delete(key: str) -> None:
    _s3().delete_object(Bucket=settings.minio_bucket, Key=key)
```

- [ ] **Step 5: 冒烟（真 MinIO 读写）+ 提交**

Run:
```bash
cd services/agent && uv run python -c "
from agent.parsing.storage_read import _put_bytes, read_bytes, _delete
_put_bytes('smoke/p.txt', b'hi'); print(read_bytes('smoke/p.txt')); _delete('smoke/p.txt')
"
```
Expected: 打印 `b'hi'`（连通 bidsaas 桶）。

```bash
git add services/agent/pyproject.toml services/agent/src/agent/config.py services/agent/src/agent/parsing/__init__.py services/agent/src/agent/parsing/types.py services/agent/src/agent/parsing/storage_read.py
git commit -m "feat(spec106): 解析依赖 + MinIO 读取 + ParsedDoc 类型

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 三类型解析器 + 分发（parsers.py）

**Files:** Create `src/agent/parsing/parsers.py`、`tests/parsing/test_parsers.py`

- [ ] **Step 1: 失败测试 `tests/parsing/test_parsers.py`（测试内生成文件，无需 fixture）**

```python
import io
from agent.parsing.parsers import parse_bytes
from agent.parsing.types import UnsupportedDocument
import pytest


def _docx_bytes(text: str) -> bytes:
    from docx import Document
    d = Document(); d.add_paragraph(text); d.add_paragraph("第二段")
    buf = io.BytesIO(); d.save(buf); return buf.getvalue()


def _xlsx_bytes() -> bytes:
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.append(["评分项", "分值"]); ws.append(["技术标", 60])
    buf = io.BytesIO(); wb.save(buf); return buf.getvalue()


def _pdf_bytes(text: str) -> bytes:
    from fpdf import FPDF
    pdf = FPDF(); pdf.add_page(); pdf.set_font("helvetica", size=12); pdf.cell(0, 10, text)
    return bytes(pdf.output())


def test_parse_docx():
    doc = parse_bytes(_docx_bytes("招标文件正文"), "tender.docx")
    assert doc.kind == "docx" and "招标文件正文" in doc.text and "第二段" in doc.text


def test_parse_xlsx_text_and_tables():
    doc = parse_bytes(_xlsx_bytes(), "score.xlsx")
    assert doc.kind == "xlsx" and "技术标" in doc.text
    assert doc.tables and doc.tables[0][0][0] == "评分项"


def test_parse_pdf():
    doc = parse_bytes(_pdf_bytes("Tender PDF Body"), "t.pdf")
    assert doc.kind == "pdf" and doc.pages == 1 and "Tender PDF Body" in doc.text


def test_unsupported_type_raises():
    with pytest.raises(UnsupportedDocument):
        parse_bytes(b"x", "a.zip")
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/agent && uv run pytest tests/parsing/test_parsers.py -q`
Expected: FAIL（`parse_bytes` 不存在）。

- [ ] **Step 3: 写 `parsing/parsers.py`**

```python
from __future__ import annotations

import io
from agent.parsing.types import ParsedDoc, UnsupportedDocument


def parse_docx(data: bytes) -> ParsedDoc:
    from docx import Document
    d = Document(io.BytesIO(data))
    paras = [p.text for p in d.paragraphs if p.text.strip()]
    tables: list[list[list[str]]] = []
    for t in d.tables:
        rows = [[c.text for c in r.cells] for r in t.rows]
        tables.append(rows)
        for r in rows:
            paras.append("\t".join(r))
    return ParsedDoc(text="\n".join(paras), kind="docx", tables=tables)


def parse_pdf(data: bytes) -> ParsedDoc:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    pages = [(pg.extract_text() or "") for pg in reader.pages]
    return ParsedDoc(text="\n".join(pages), kind="pdf", pages=len(reader.pages))


def parse_xlsx(data: bytes) -> ParsedDoc:
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    tables: list[list[list[str]]] = []
    lines: list[str] = []
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = ["" if v is None else str(v) for v in row]
            if any(c.strip() for c in cells):
                rows.append(cells)
                lines.append("\t".join(cells))
        if rows:
            tables.append(rows)
    return ParsedDoc(text="\n".join(lines), kind="xlsx", tables=tables)


_DISPATCH = {"docx": parse_docx, "pdf": parse_pdf, "xlsx": parse_xlsx}


def parse_bytes(data: bytes, filename: str) -> ParsedDoc:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    fn = _DISPATCH.get(ext)
    if not fn:
        raise UnsupportedDocument(f"不支持的文档类型: .{ext}")
    return fn(data)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd services/agent && uv run pytest tests/parsing/test_parsers.py -q`
Expected: 4 passed（docx/xlsx/pdf/不支持类型）。

- [ ] **Step 5: 提交**

```bash
git add services/agent/src/agent/parsing/parsers.py services/agent/tests/parsing/test_parsers.py
git commit -m "feat(spec106): docx/pdf/xlsx 解析器 + 分发 + 单测

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: read_and_parse + 工具 + 真 MinIO 往返 + 合并

**Files:** Create `src/agent/parsing/service.py`、`parsing/tool.py`、`tests/parsing/test_read_and_parse.py`

- [ ] **Step 1: 写 `parsing/service.py`**

```python
from __future__ import annotations
from agent.parsing.parsers import parse_bytes
from agent.parsing.storage_read import read_bytes
from agent.parsing.types import ParsedDoc


def read_and_parse(key: str) -> ParsedDoc:
    """从 MinIO 按 key 取文件并解析（key 末段含扩展名）。"""
    data = read_bytes(key)
    return parse_bytes(data, key)
```

- [ ] **Step 2: 写 `parsing/tool.py`（给智能体挂的工具）**

```python
from __future__ import annotations
from langchain_core.tools import StructuredTool
from agent.parsing.service import read_and_parse


async def _parse_document(key: str) -> str:
    """解析 MinIO 上的招标文件，返回纯文本（超长由调用方/压缩节点处理）。"""
    return read_and_parse(key).text


parse_document_tool = StructuredTool.from_function(
    coroutine=_parse_document, name="parse_document", description="按对象存储 key 解析招标文件(docx/pdf/xlsx)为文本"
)
```

- [ ] **Step 3: 写真 MinIO 往返测试 `tests/parsing/test_read_and_parse.py`**

```python
import io
import uuid
from agent.parsing.service import read_and_parse
from agent.parsing.storage_read import _put_bytes, _delete


def _docx_bytes(text: str) -> bytes:
    from docx import Document
    d = Document(); d.add_paragraph(text)
    buf = io.BytesIO(); d.save(buf); return buf.getvalue()


def test_read_and_parse_from_minio():
    key = f"uploads/test/{uuid.uuid4()}/tender.docx"
    _put_bytes(key, _docx_bytes("招标编号 ZB-2026-001"))
    try:
        doc = read_and_parse(key)
        assert doc.kind == "docx" and "ZB-2026-001" in doc.text
    finally:
        _delete(key)
```

- [ ] **Step 4: 运行（真 MinIO）+ 全量 + lint**

Run: `cd services/agent && uv run pytest tests/parsing -q && uv run ruff check src`
Expected: 全 passed（含真 MinIO 往返），ruff 无错。

- [ ] **Step 5: 提交并合并**

```bash
git add services/agent/src/agent/parsing/service.py services/agent/src/agent/parsing/tool.py services/agent/tests/parsing/test_read_and_parse.py
git commit -m "feat(spec106): read_and_parse + parse_document 工具 + 真 MinIO 往返

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git checkout main
git merge --no-ff phase1/spec106-doc-parsing -m "merge spec106: 文档解析"
git push origin main
```

---

## 验收清单（spec106 完成判据）

- [ ] `parse_bytes` 正确解析 docx（段落+表格）/pdf（文本+页数）/xlsx（文本+表格）；不支持类型抛 `UnsupportedDocument`。
- [ ] `read_bytes(key)` 从 MinIO（bidsaas 桶）取字节；`read_and_parse(key)` 端到端可用。
- [ ] `parse_document` 工具可挂给智能体（入参 key → 文本）。
- [ ] 文件只按 key 读、不传二进制；横切、不碰钱。
- [ ] 扫描件 OCR 标注为 Phase 1 范围外（加固再做）。
- [ ] `uv run pytest tests/parsing` + `ruff` 全绿（含真 MinIO 往返）。
