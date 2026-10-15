"""Child side of the reference sandbox (tests/fuzz/target.py). NOT imported by the test process.

Usage: python -I _child.py {pdf|dxf|png} PATH   (limits in $KAMUTAN_FUZZ_LIMITS)
Prints one JSON line: {"ok": true, "stats": {...}} or {"ok": false, "code": ..., "message": ..., "exc": ...}.
Mirrors what the ingest stage does with a file: open, count, bounded geometry/text extraction, small render.
PDF actions/JS/embedded files are never executed (pdfium does not run them without a form env).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

LIMITS: dict[str, Any] = json.loads(os.environ.get("KAMUTAN_FUZZ_LIMITS", "{}"))
MAX_PIXELS = int(LIMITS.get("max_pixels", 200_000_000))
MAX_PAGES = int(LIMITS.get("max_pages", 100))
RENDER_DPI = int(LIMITS.get("render_dpi", 36))


class Limit(Exception):
    pass


def emit(obj: dict[str, Any], rc: int = 0) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
    os._exit(rc)  # skip interpreter teardown of half-broken native objects


def parse_pdf(path: str) -> dict[str, Any]:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(path)
    try:
        n = len(doc)
        if n > MAX_PAGES:
            raise Limit(f"{n} pages > {MAX_PAGES}")
        stats: dict[str, Any] = {"pages": n, "objects": 0, "rendered": 0}
        for i in range(min(n, 3)):
            page = doc[i]
            w, h = page.get_size()  # points
            px = (w * RENDER_DPI / 72.0) * (h * RENDER_DPI / 72.0)
            if not (w > 0 and h > 0) or px > MAX_PIXELS:
                raise Limit(f"page {i} size {w:.0f}x{h:.0f}pt exceeds the pixel cap")
            k = 0
            for _obj in page.get_objects(max_depth=15):
                k += 1
                if k > int(LIMITS.get("max_objects", 2_000_000)):
                    raise Limit("too many page objects")
            stats["objects"] += k
            textpage = page.get_textpage()
            stats.setdefault("chars", 0)
            stats["chars"] += textpage.count_chars()
            textpage.close()
            bmp = page.render(scale=RENDER_DPI / 72.0)
            stats["rendered"] += 1
            bmp.close()
            page.close()
        if n:
            # the production vector extractor on page 0 (bounded by the page-size check above)
            from kamutan_drawing.ingest.pdf_vector import extract_pdf

            vs = extract_pdf(path, pages=[0])[0]
            stats["segments"] = int(vs.stats.get("segments", 0)) if hasattr(vs, "stats") else 0
        return stats
    finally:
        doc.close()


def parse_dxf(path: str) -> dict[str, Any]:
    import ezdxf
    from ezdxf import recover

    try:
        doc = ezdxf.readfile(path)
    except ezdxf.DXFStructureError:
        doc, _auditor = recover.readfile(path)
    msp = doc.modelspace()
    stats = {"entities": 0, "exploded": 0, "blocks": len(doc.blocks), "xrefs": 0}
    budget = int(LIMITS.get("max_entities", 50_000))
    for blk in doc.blocks:
        if blk.block is not None and blk.block.is_xref:
            stats["xrefs"] += 1  # never resolved: external files are ignored (SEC-17)
    for _e in msp:
        stats["entities"] += 1
        if stats["entities"] > budget:
            raise Limit("entity budget exceeded")
    # Full recursive block explosion, as a DXF ingest must do to see every symbol. Cycles and
    # billion-laughs fan-out must end in a typed error (budget / RecursionError), never a hang.
    from ezdxf.disassemble import recursive_decompose

    for _v in recursive_decompose(msp):
        stats["exploded"] += 1
        if stats["exploded"] > budget:
            raise Limit("block expansion budget exceeded")
    return stats


def parse_png(path: str) -> dict[str, Any]:
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS // 2  # Pillow raises DecompressionBombError at 2x this value
    with Image.open(path) as im:
        w, h = im.size
        if w * h > MAX_PIXELS:
            raise Limit(f"{w}x{h} exceeds {MAX_PIXELS} px")
        im.verify()
    with Image.open(path) as im:
        im.draft("L", (1024, 1024))
        im.load()
        return {"width": w, "height": h, "mode": im.mode}


# ----------------------------------------------------------------------------- production parsers
# When the worker's parse modules exist, fuzz THEM (same calls an ingest task makes on page 0);
# the built-in parse_* above remain the fallback (KAMUTAN_FUZZ_PARSERS=builtin forces them).


def prod_pdf(path: str) -> dict[str, Any]:
    from kamutan_drawing.parse import pdf

    pages = pdf.probe(path)
    src = pdf.PdfPageSource.open(path, 0)
    try:
        vs = src.vectors()
        ppm = RENDER_DPI / 25.4
        img = src.render(ppm, 0, 0, max(1, min(1024, int(src.width_mm * ppm))), max(1, min(1024, int(src.height_mm * ppm))))
        text = src.text_layer()
        return {
            "pages": len(pages),
            "segments": int(getattr(vs, "stats", {}).get("segments", 0)),
            "img": list(img.size),
            "text": len(text),
        }
    finally:
        src.close()


def prod_dxf(path: str) -> dict[str, Any]:
    from kamutan_drawing.parse import dxf

    doc = dxf.load_doc(path)
    page = dxf.extract_page(doc, 0)
    return {"page": type(page).__name__}


def prod_png(path: str) -> dict[str, Any]:
    from kamutan_drawing.parse import raster

    pages = raster.probe(path)
    src = raster.RasterSource.open(path, load=True)
    return {"pages": len(pages), "size": list(src.img.size)}


def pick(kind: str):  # type: ignore[no-untyped-def]
    builtin = {"pdf": parse_pdf, "dxf": parse_dxf, "png": parse_png}[kind]
    if os.environ.get("KAMUTAN_FUZZ_PARSERS", "production") == "builtin":
        return builtin
    try:
        __import__(f"kamutan_drawing.parse.{ {'png': 'raster'}.get(kind, kind) }")
    except ImportError:
        return builtin
    return {"pdf": prod_pdf, "dxf": prod_dxf, "png": prod_png}[kind]


def main() -> None:
    kind, path = sys.argv[1], sys.argv[2]
    try:
        stats = pick(kind)(path)
    except Limit as e:
        emit({"ok": False, "code": "limit_exceeded", "message": str(e)[:300]}, 3)
    except MemoryError:
        emit({"ok": False, "code": "resource_limit", "message": "out of memory"}, 4)
    except RecursionError:
        emit({"ok": False, "code": "limit_exceeded", "message": "recursion limit"}, 3)
    except Exception as e:  # noqa: BLE001 - the child reports every parser failure as data
        name = type(e).__name__
        code = getattr(e, "code", None)
        if isinstance(code, str) and code:  # production IngestError: keep its stable code
            emit({"ok": False, "code": code, "message": str(e)[:300], "exc": name}, 3)
        code = "limit_exceeded" if name == "DecompressionBombError" else "invalid_input"
        emit({"ok": False, "code": code, "message": str(e)[:300], "exc": name}, 3)
    emit({"ok": True, "stats": stats}, 0)


if __name__ == "__main__":
    main()
