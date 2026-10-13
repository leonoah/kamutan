"""Per-page processing inside the sandbox: render → vectors → text → classify → regions/scale.

Input arrives from the orchestrator as plain data (a local file path relative to the
sandbox working directory, options, the org glyph store snapshot). Bulky outputs are
written as files under ``outDir`` (relative); everything else is returned as data.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .. import errors as E
from ..classify.regions import assign_floors
from ..classify.sheet import R_DPI_UNKNOWN, R_DXF_UNITS, R_LOW_RES, classify_page, span_from_line, span_to_line
from ..errors import IngestError
from ..ingest.pdf_vector import VectorSheet
from ..ocr.dictionary import TextSpan
from ..pipeline.artifacts import encode_primitives, encode_text
from ..render.tiles import Pyramid, write_pyramid, write_thumbnail
from .vectors import empty_sheet

Progress = Callable[[str, int], None]

# page progress (0..100) at the start of each brief stage
STAGE_PCT = {"ingest": 0, "render": 10, "ocr": 40, "classify": 75, "scale": 85, "done": 100}


def _rel_inside(workdir: Path, rel: str) -> Path:
    p = (workdir / rel).resolve()
    if workdir.resolve() not in p.parents and p != workdir.resolve():
        raise IngestError(E.INTERNAL, "path escapes the sandbox directory", retryable=False)
    return p


def process_page(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    wd = Path.cwd()
    kind = str(args["kind"])
    src_path = str(_rel_inside(wd, str(args["path"])))
    index = int(args["index"])
    out = _rel_inside(wd, str(args["outDir"]))
    out.mkdir(parents=True, exist_ok=True)
    dpi = float(args.get("dpi", 300))
    do_ocr = bool(args.get("ocr", True))
    tiles_on = bool(args.get("tiles", True))
    timings: dict[str, float] = {}
    t = time.monotonic()

    def lap(name: str) -> None:
        nonlocal t
        now = time.monotonic()
        timings[name] = round(now - t, 3)
        t = now

    progress("ingest", 1)
    extra_yellow: list[str] = []
    inserts: list[dict[str, Any]] = []
    direct_lines: list[dict[str, Any]] = []
    raster = False
    known_scale: int | None = None
    check_dims = True
    closer: Callable[[], None] = lambda: None
    rotation = 0
    if kind == "pdf":
        from .pdf import PdfPageSource

        src = PdfPageSource.open(src_path, index)
        closer = src.close
        vs: VectorSheet = src.vectors()
        render = src.render
        w_mm, h_mm, rotation = src.width_mm, src.height_mm, src.rotation
        direct_lines = src.text_layer()
    elif kind == "dxf":
        from .dxf import extract_page, load_doc
        from .vectors import VectorPainter

        dp = extract_page(load_doc(src_path), index)
        vs = dp.vs
        render = VectorPainter([dp.vs, dp.text_vs]).render
        w_mm, h_mm = dp.width_mm, dp.height_mm
        direct_lines = [{k: v for k, v in ln.items() if k != "layer"} for ln in dp.texts]
        inserts = dp.inserts
        known_scale = dp.scale_den
        check_dims = False  # model space is mapped to paper with a known scale
        if not dp.units_known:
            extra_yellow.append(R_DXF_UNITS)
    elif kind in ("png", "jpg"):
        from .raster import LOW_DPI, RasterSource

        rs = RasterSource.open(src_path)
        render = rs.render
        w_mm, h_mm = rs.width_mm, rs.height_mm
        vs = empty_sheet(0, w_mm, h_mm)
        raster = True
        dpi = rs.dpi  # the max level is the native resolution
        if not rs.dpi_known:
            extra_yellow.append(R_DPI_UNKNOWN)
        elif rs.dpi < LOW_DPI:
            extra_yellow.append(R_LOW_RES)
    else:
        raise IngestError(E.UNSUPPORTED_FORMAT, f"unsupported kind {kind}")
    lap("ingest")

    try:
        # ---------------------------------------------------------------- render
        progress("render", STAGE_PCT["render"])
        pyr = Pyramid.for_page(w_mm, h_mm, dpi)
        tile_files: list[str] = []
        if tiles_on:
            span = STAGE_PCT["ocr"] - STAGE_PCT["render"]
            tile_files = write_pyramid(
                render, pyr, out, on_level=lambda i, n: progress("render", STAGE_PCT["render"] + span * i // n)
            )
        thumb = write_thumbnail(render, w_mm, h_mm, out)
        lap("render")

        # ---------------------------------------------------------------- text
        progress("ocr", STAGE_PCT["ocr"])
        spans: list[TextSpan] = []
        text_paths: list[int] = []
        glyph_delta: dict[str, Any] | None = None
        text_stats: dict[str, Any] = {}
        source = "none"
        if kind == "pdf":
            from ..ocr.glyphs import extract_text_lines
            from ..ocr.reader import read_page_text
            from ..ocr.shapes import GlyphStore

            lines = extract_text_lines(vs, str(args.get("sheet", "")))
            text_paths = [p for ln in lines for g in ln.glyphs for p in g.paths]
            if lines:
                store = GlyphStore.from_bytes(args.get("glyphStore"))
                pt = read_page_text(lines, store, str(args.get("contribution", "")), ocr=do_ocr)
                spans = pt.spans
                glyph_delta = pt.delta.to_obj()
                text_stats = pt.stats
                source = "shx-glyph-dictionary"
            if direct_lines:
                spans += [span_from_line(ln) for ln in direct_lines]
                source = "pdf-text" if source == "none" else "mixed"
        elif kind == "dxf":
            spans = [span_from_line(ln) for ln in direct_lines]
            source = "dxf"
        elif raster and do_ocr:
            direct_lines = rs.ocr_lines()
            spans = [span_from_line(ln) for ln in direct_lines]
            source = "tesseract"
        lap("ocr")

        # ---------------------------------------------------------------- classify
        progress("classify", STAGE_PCT["classify"])
        cls = classify_page(
            spans, vs, raster=raster, known_scale=known_scale, extra_yellow=extra_yellow, check_dimensions=check_dims
        )
        lap("classify")

        # ---------------------------------------------------------------- regions + scale
        progress("scale", STAGE_PCT["scale"])
        reg = assign_floors(vs, spans, cls.floors, cls.scale_den, exclude_paths=set(text_paths), title_block=cls.title_block_bbox)
        if reg.yellow:
            cls.reasons = list(dict.fromkeys(cls.reasons + reg.yellow))
            if cls.level == "green":
                cls.level = "yellow"
        cls.reasons = list(dict.fromkeys(cls.reasons + reg.info))
        lap("regions")

        (out / "primitives.msgpack.gz").write_bytes(
            encode_primitives(vs, rotation=rotation, inserts=inserts, text_paths=text_paths)
        )
        lines_out = [span_to_line(s) for s in spans]
        (out / "text.json.gz").write_bytes(encode_text(lines_out, source))
        lap("write")
    finally:
        closer()

    rel = out.relative_to(wd).as_posix()
    return {
        "page": {"index": index, "widthMm": round(w_mm, 3), "heightMm": round(h_mm, 3), "rotation": rotation},
        "outDir": rel,
        "tileFiles": tile_files,
        "thumbnail": thumb,
        "tiles": pyr.meta(),
        "classification": cls.to_doc(),
        "discipline": cls.discipline,
        "floors": cls.floors,
        "scaleDenominator": cls.scale_den,
        "scaleCheck": {k: v for k, v in cls.scale.items() if k != "samples"},
        "classificationSource": cls.source,
        "regions": reg.regions,
        "stats": {
            "paths": vs.n_paths,
            "segments": vs.n_segs,
            "textLines": len(spans),
            "glyphs": int(text_stats.get("glyphs", 0)),
            "inserts": len(inserts),
        },
        "textStats": text_stats,
        "textSource": source,
        "glyphDelta": glyph_delta,
        "timings": timings,
    }
