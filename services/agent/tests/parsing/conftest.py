import io

import pytest


@pytest.fixture
def docgen():
    """三类型测试文件生成器（docx/xlsx/pdf），供 parsing 测试共用。"""
    class _Gen:
        @staticmethod
        def docx(*paras: str) -> bytes:
            from docx import Document
            d = Document()
            for p in paras:
                d.add_paragraph(p)
            buf = io.BytesIO()
            d.save(buf)
            return buf.getvalue()

        @staticmethod
        def xlsx() -> bytes:
            from openpyxl import Workbook
            wb = Workbook()
            ws = wb.active
            ws.append(["评分项", "分值"])
            ws.append(["技术标", 60])
            buf = io.BytesIO()
            wb.save(buf)
            return buf.getvalue()

        @staticmethod
        def pdf(text: str) -> bytes:
            from fpdf import FPDF
            pdf = FPDF()
            pdf.add_page()
            pdf.set_font("helvetica", size=12)
            pdf.cell(0, 10, text)
            return bytes(pdf.output())

    return _Gen
