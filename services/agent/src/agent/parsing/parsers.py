from __future__ import annotations

import io
import re

from agent.parsing.types import ParsedDoc, UnsupportedDocument

# 章节标题启发式：第N章/第N节/第N篇/第N部分，或「一、二、」式顶层编号（标题一般较短）。
_HEADING = re.compile(r"^(第\s*[一二三四五六七八九十百零〇\d]+\s*[章节篇部分]|[一二三四五六七八九十]+\s*[、．.])")


def _is_heading(t: str) -> bool:
    return len(t) <= 40 and bool(_HEADING.match(t))


def _split_clauses(lines: list[str]) -> list[dict]:
    """按章节标题分节、节内非空段落顺序编号 → [{id: sec-N-cN, text}]。
    启发式（不 OCR/精排版）：无法识别章节时整体退化为 sec-1，供读标/提纲引用作 clause_ids 定位。"""
    clauses: list[dict] = []
    sec_n = 1
    sec_id = "sec-1"
    c_n = 0
    seen_heading = False
    for raw in lines:
        t = raw.strip()
        if not t:
            continue
        if _is_heading(t):
            if seen_heading or clauses:      # 前面已有章节或正文，才递增（首个标题保持 sec-1）
                sec_n += 1
            sec_id = f"sec-{sec_n}"
            seen_heading = True
            c_n = 0
            continue                          # 标题本身不作为条款
        c_n += 1
        clauses.append({"id": f"{sec_id}-c{c_n}", "text": t})
    return clauses


def parse_docx(data: bytes) -> ParsedDoc:
    from docx import Document
    d = Document(io.BytesIO(data))
    para_texts = [p.text for p in d.paragraphs if p.text.strip()]
    text_parts = list(para_texts)
    tables: list[list[list[str]]] = []
    for t in d.tables:
        rows = [[c.text for c in r.cells] for r in t.rows]
        tables.append(rows)
        for r in rows:
            text_parts.append("\t".join(r))
    return ParsedDoc(text="\n".join(text_parts), kind="docx", tables=tables,
                     clauses=_split_clauses(para_texts))


def parse_pdf(data: bytes) -> ParsedDoc:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    pages = [(pg.extract_text() or "") for pg in reader.pages]
    text = "\n".join(pages)
    return ParsedDoc(text=text, kind="pdf", pages=len(reader.pages),
                     clauses=_split_clauses(text.split("\n")))


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
    return ParsedDoc(text="\n".join(lines), kind="xlsx", tables=tables,
                     clauses=_split_clauses(lines))


_DISPATCH = {"docx": parse_docx, "pdf": parse_pdf, "xlsx": parse_xlsx}


def parse_bytes(data: bytes, filename: str) -> ParsedDoc:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    fn = _DISPATCH.get(ext)
    if not fn:
        raise UnsupportedDocument(f"不支持的文档类型: .{ext}")
    return fn(data)
