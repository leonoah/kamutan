"""Worker-side magic-byte detection (SEC-14, security gate G2): extension/content-type are never trusted."""

from __future__ import annotations

import pytest

from kamutan_drawing.formats import DXF_BINARY, compatible, detect_kind

from .pipeline_util import lighting_dxf, multipage_pdf, raster_png


@pytest.mark.parametrize(
    ("head", "kind"),
    [
        (b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "pdf"),
        (b"%PDF-2.0", "pdf"),
        (b"\r\n  junk-before-header\n%PDF-1.4\n", "pdf"),  # some generators prepend bytes (< 1 KiB)
        (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "png"),
        (b"\xff\xd8\xff\xe0\x00\x10JFIF\x00", "jpg"),
        (b"\xff\xd8\xff\xe1\x00\x10Exif\x00", "jpg"),
        (b"AC1032\x00\x00\x00", "dwg"),  # AutoCAD 2018
        (b"AC1015\x00\x00\x00", "dwg"),  # AutoCAD 2000
        (b"AC1027", "dwg"),
        (DXF_BINARY + b"\x00\x00", "dxf"),
        (b"  0\r\nSECTION\r\n  2\r\nHEADER\r\n", "dxf"),
        (b"0\nSECTION\n2\nENTITIES\n", "dxf"),
        (b"999\nwritten by a tool\n0\nSECTION\n", "dxf"),  # leading comment
        (b"\xef\xbb\xbf0\nSECTION\n", "dxf"),  # UTF-8 BOM
    ],
)
def test_detects_allowed_kinds(head: bytes, kind: str) -> None:
    assert detect_kind(head) == kind


@pytest.mark.parametrize(
    "head",
    [
        b"",
        b"%PD",
        b"MZ\x90\x00\x03\x00\x00\x00",  # Windows executable renamed .pdf (ING-12)
        b"\x7fELF\x02\x01\x01",
        b"PK\x03\x04\x14\x00",  # zip / docx / xlsx
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",  # OLE2 (xls, old dwg viewers)
        b"<!DOCTYPE html><script>alert(1)</script>",
        b"<?xml version='1.0'?><svg/>",
        b"GIF89a\x01\x00",
        b"II*\x00",  # TIFF: not accepted
        b"AC1009",  # R11/R12 DWG: older than LibreDWG supports reliably
        b"AC2032",
        b"0\nSECTIONX\n",
        b"SECTION\n0\n",
        b"\x00" * 10 + b"%PDF-1.4",  # NUL bytes before the header
        b"x" * 1100 + b"%PDF-1.4",  # header beyond 1 KiB
        b"\x89PNX\r\n\x1a\n",
        b"\xff\xd8\x00",
    ],
)
def test_rejects_everything_else(head: bytes) -> None:
    assert detect_kind(head) is None


def test_real_generated_files() -> None:
    assert detect_kind(multipage_pdf(1)[:4096]) == "pdf"
    assert detect_kind(lighting_dxf()[:4096]) == "dxf"
    assert detect_kind(raster_png("PNG")[:4096]) == "png"
    assert detect_kind(raster_png("JPEG")[:4096]) == "jpg"


@pytest.mark.parametrize(
    ("declared", "detected", "ok"),
    [
        ("pdf", "pdf", True),
        ("png", "jpg", True),  # PNG/JPEG are one raster family (contracts FileKind has no 'jpg')
        ("png", "png", True),
        ("pdf", "png", False),
        ("dxf", "dwg", False),
        ("dwg", "dxf", False),
        ("png", "pdf", False),
    ],
)
def test_compatible(declared: str, detected: str, ok: bool) -> None:
    assert compatible(declared, detected) is ok
