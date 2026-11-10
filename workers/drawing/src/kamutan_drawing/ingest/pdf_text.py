"""Repair of broken ``/ToUnicode`` CMaps in AutoCAD PDFs (Sprint 10, Worker-Classify).

Root cause of the garbled Hebrew in the Rubel / Achituv / Yahav text layer: AutoCAD's PDF writer embeds the full
ArialMT as a CID TrueType font (``/Encoding /Identity-H``, char code = glyph id; the descendant font says
``/Registry (PDFAUTOCAD) /Ordering (Indentity0)``) and writes a ``/ToUnicode`` CMap whose Hebrew entries are wrong and
many-to-one (glyph ``uni05D0`` "א" → U+05D5 "ו", ``uni05E7`` "ק" → U+05E4 "פ", ``uni05D9`` "י" → U+05E2 "ע" …). pdfium
trusts the CMap, so every Hebrew word of the text layer came out as a different word ("מזגן" survived only because its
letters happen to map onto themselves); Latin, digits and punctuation map correctly, which is why circuit tags read.
Noah's sheets have no font at all (every letter is SHX strokes, read by the glyph dictionary), so it never hit this.

The embedded font is not subset and carries its own ``cmap`` table (glyph id → Unicode), which is right. This module
rebuilds the ToUnicode of such fonts from the font's own cmap and returns the PDF as an *incremental update* (the
original bytes + the new CMap objects + an xref section), which pdfium opens for the text layer. Pure; runs in the
sandbox; any parsing problem → ``None`` (the caller keeps the original text layer).
"""

from __future__ import annotations

import io
import logging
import re
from collections.abc import Iterator
from typing import Any

log = logging.getLogger(__name__)

MIN_WRONG = 3  # a CMap is repaired only when at least this many …
MIN_WRONG_SHARE = 0.2  # … and this share of its mapped glyphs disagree with the font's own cmap
MAX_FONT_BYTES = 30 * 1024 * 1024
MAX_FONTS = 64
MAX_DEPTH = 4  # form XObjects nested in resources

_HEX = r"<([0-9a-fA-F]{2,8})>"
_BFCHAR = re.compile(r"beginbfchar(.*?)endbfchar", re.DOTALL)
_BFRANGE = re.compile(r"beginbfrange(.*?)endbfrange", re.DOTALL)
_PAIR = re.compile(_HEX + r"\s*" + _HEX)
_RANGE = re.compile(_HEX + r"\s*" + _HEX + r"\s*" + _HEX)


def parse_tounicode(text: str) -> dict[int, int]:
    """``{code: unicode}`` of the single-codepoint ``bfchar`` / ``bfrange`` entries of a ToUnicode CMap (array
    ranges and multi-codepoint targets are skipped: they are never repaired)."""
    out: dict[int, int] = {}
    for block in _BFCHAR.findall(text):
        for a, b in _PAIR.findall(block):
            if len(b) <= 4:
                out[int(a, 16)] = int(b, 16)
    for block in _BFRANGE.findall(text):
        for a, b, c in _RANGE.findall(block):
            lo, hi, u = int(a, 16), int(b, 16), int(c, 16)
            if len(c) <= 4 and 0 <= hi - lo <= 0xFFFF:
                for k in range(lo, hi + 1):
                    out[k] = u + (k - lo)
    return out


def tounicode_cmap(mapping: dict[int, int]) -> bytes:
    """A ToUnicode CMap (2-byte codes, Identity-H) with one ``bfchar`` per code, in blocks of 100 (the PDF limit)."""
    items = sorted(mapping.items())
    blocks = []
    for i in range(0, len(items), 100):
        chunk = items[i : i + 100]
        blocks.append(f"{len(chunk)} beginbfchar\n" + "\n".join(f"<{c:04x}> <{u:04x}>" for c, u in chunk) + "\nendbfchar\n")
    return (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" + "".join(blocks) + "endcmap\n"
        "CMapName currentdict /CMap defineresource pop\nend\nend\n"
    ).encode("ascii")


def font_gid_unicode(font_bytes: bytes) -> dict[int, int]:
    """Glyph id → Unicode from a TrueType font's own ``cmap`` (Hebrew wins when a glyph has several code points)."""
    from fontTools.ttLib import TTFont  # type: ignore[import-untyped]  # ezdxf's dependency, no stubs

    tt = TTFont(io.BytesIO(font_bytes), lazy=True)
    try:
        cmap = tt.getBestCmap() or {}
        out: dict[int, int] = {}
        for u, name in cmap.items():
            gid = tt.getGlyphID(name)
            if gid not in out or 0x0590 <= u < 0x0600:
                out[gid] = u
        return out
    finally:
        tt.close()


def repaired_mapping(old: dict[int, int], font: dict[int, int]) -> dict[int, int] | None:
    """The corrected ``{code: unicode}`` or None when the CMap agrees with the font well enough. Codes the font's cmap
    does not know keep their old target (ligatures, unmapped glyphs)."""
    known = [c for c in old if c in font]
    wrong = [c for c in known if font[c] != old[c]]
    if len(wrong) < MIN_WRONG or len(wrong) < MIN_WRONG_SHARE * max(1, len(known)):
        return None
    return {c: font.get(c, u) for c, u in old.items()}


def _type0_fonts(resources: Any, depth: int = 0) -> Iterator[Any]:
    if resources is None or depth > MAX_DEPTH:
        return
    res = resources.get_object()
    fonts = res.get("/Font")
    if fonts is not None:
        for ref in fonts.get_object().values():
            f = ref.get_object()
            if f.get("/Subtype") == "/Type0":
                yield f
    xobjs = res.get("/XObject")
    if xobjs is not None:
        for ref in xobjs.get_object().values():
            x = ref.get_object()
            if x.get("/Subtype") == "/Form" and x.get("/Resources") is not None:
                yield from _type0_fonts(x["/Resources"], depth + 1)


def _repair_font(f: Any) -> bytes | None:
    """The new ToUnicode stream content for one Type0 font, or None."""
    if f.get("/Encoding") != "/Identity-H" or f.get("/ToUnicode") is None:
        return None
    desc = f["/DescendantFonts"].get_object()[0].get_object()
    if desc.get("/Subtype") != "/CIDFontType2":
        return None
    c2g = desc.get("/CIDToGIDMap")
    if c2g is not None and c2g != "/Identity":
        return None  # a stream map: codes are not glyph ids
    ff = desc["/FontDescriptor"].get_object().get("/FontFile2")
    if ff is None:
        return None
    data = ff.get_object().get_data()
    if len(data) > MAX_FONT_BYTES:
        return None
    old = parse_tounicode(f["/ToUnicode"].get_object().get_data().decode("latin-1"))
    new = repaired_mapping(old, font_gid_unicode(data))
    return tounicode_cmap(new) if new is not None else None


def repaired_pdf(path: str, page_index: int) -> bytes | None:
    """The PDF with corrected ToUnicode CMaps for the fonts used on ``page_index`` (incremental update), or None
    when no font of that page needs a repair or anything fails."""
    plog = logging.getLogger("pypdf")
    level = plog.level
    plog.setLevel(logging.ERROR)  # AutoCAD files trip harmless pypdf warnings ("Multiple definitions … /PageMode")
    try:
        from pypdf import PdfWriter
        from pypdf.generic import DecodedStreamObject, NameObject

        w = PdfWriter(path, incremental=True)
        if not 0 <= page_index < len(w.pages):
            return None
        page = w.pages[page_index]
        changed = 0
        for k, f in enumerate(_type0_fonts(page.get("/Resources"))):
            if k >= MAX_FONTS:
                break
            cmap = _repair_font(f)
            if cmap is None:
                continue
            s = DecodedStreamObject()
            s.set_data(cmap)
            f[NameObject("/ToUnicode")] = w._add_object(s)
            changed += 1
        if not changed:
            return None
        out = io.BytesIO()
        w.write(out)
        log.info("repaired %d ToUnicode CMap(s) on page %d", changed, page_index)
        return out.getvalue()
    except Exception:  # untrusted file: never fail the page for the repair, keep the original text layer
        log.warning("ToUnicode repair skipped", exc_info=True)
        return None
    finally:
        plog.setLevel(level)
