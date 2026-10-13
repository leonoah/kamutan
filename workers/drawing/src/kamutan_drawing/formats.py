"""File type detection by magic bytes (SEC-14). Extension and Content-Type are hints only."""

from __future__ import annotations

import re
from typing import Literal

Kind = Literal["pdf", "dxf", "dwg", "png", "jpg"]

_DWG = re.compile(rb"^AC10(1[2-9]|2[0-9]|3[0-9])")
_DXF_ASCII = re.compile(rb"^\s*(999\s*\r?\n[^\r\n]*\r?\n\s*)*0\s*\r?\n\s*SECTION\s*\r?\n", re.DOTALL)
DXF_BINARY = b"AutoCAD Binary DXF\r\n\x1a\x00"


def detect_kind(head: bytes) -> Kind | None:
    """Kind from the first bytes of a file (pass at least 1 KiB), or None if not allowed."""
    if head.startswith(b"%PDF-"):
        return "pdf"
    # tolerate a little junk before the PDF header (common with some generators), never more than 1 KiB
    i = head.find(b"%PDF-", 0, 1024)
    if i > 0 and b"\x00" not in head[:i]:
        return "pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if _DWG.match(head):
        return "dwg"
    if head.startswith(DXF_BINARY):
        return "dxf"
    h = head[3:] if head.startswith(b"\xef\xbb\xbf") else head
    if _DXF_ASCII.match(h[:4096]):
        return "dxf"
    return None


RASTER_KINDS = frozenset({"png", "jpg"})


def compatible(declared: str, detected: str) -> bool:
    """The job's ``fileKind`` vs. the detected kind. PNG/JPEG are one raster family."""
    if declared == detected:
        return True
    return declared in RASTER_KINDS and detected in RASTER_KINDS


CONTENT_TYPES: dict[str, str] = {
    "pdf": "application/pdf",
    "dxf": "application/dxf",
    "dwg": "application/acad",
    "png": "image/png",
    "jpg": "image/jpeg",
}
