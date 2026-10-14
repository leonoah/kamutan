"""Sprint-2 "understanding" stage of one page (runs inside the parser sandbox, task ``understand``).

Input: the page's own artifacts written by the ``page`` task (``primitives.msgpack.gz``,
``text.json.gz``) plus plain data from the orchestrator (discipline, scale, regions, the org's
remembered symbol mappings / linked legend entries). Stages (progress ``legend`` → ``detect`` →
``rooms``):

1. **legend** — :func:`kamutan_drawing.legend.parse.parse_legends` on every sheet (cheap);
2. **detect** — symbols, tags, text anchors, unknown clusters on electrical / lighting / plumbing
   sheets only (:func:`kamutan_drawing.symbols.detect.detect_symbols`); raster sheets use the
   pixel fallback (:mod:`kamutan_drawing.symbols.raster`, capped at yellow);
3. **rooms** — Worker-B's ``rooms.segment`` on architecture / master sheets and any sheet with
   room names; detections get ``roomId`` / ``floor`` by point-in-polygon (regions as fallback);
   ``lifecycle.classify`` sets existing / new / demolish;
4. **links** (Sprint 3, lighting sheets) — switch ↔ luminaire groups from the dashed wiring arcs
   (:mod:`kamutan_drawing.links`) → ``links.json.gz`` (``kamutan.links/1``) + ``linkStats``.

Floors confirmed by the user (``floorsConfirmed``, the sheet doc's ``confirmed``) are authoritative:
the regions' floors are used and no ``קומה לא ודאית`` chip is added. :func:`apply_confirmed_floors`
applies the same effect to stored artifacts without re-parsing (``boq.build``).

Outputs (files under ``outDir``): ``legend.json.gz``, ``detections.json.gz``, ``rooms.json.gz``,
``links.json.gz`` (lighting sheets only),
``legend/{entryId}.webp``, ``unknown/{clusterId}.webp``; the return value lists them plus the
legend entries for Firestore and the stats. Every output is deterministic for the same input
(idempotent re-runs).
"""

from __future__ import annotations

import gzip
import io
import json
import logging
import time
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from ..ingest.pdf_vector import VectorSheet
from ..legend.parse import LegendEntry, LegendResult, parse_legends
from ..links import LINK_DISCIPLINES, link_sheet
from ..links.floors import apply_confirmed_floors
from ..ocr.dictionary import TextSpan
from ..symbols.detect import Detection, DetectResult, detect_symbols, score_detection
from ..symbols.geometry import BBox, bbox_dict, stroke_signatures
from .artifacts import decode_primitives, decode_text

log = logging.getLogger(__name__)

Progress = Callable[[str, int], None]

LEGEND_SCHEMA = "kamutan.legend/1"
DETECTIONS_SCHEMA = "kamutan.detections/1"
ROOMS_SCHEMA = "kamutan.rooms/1"
DETECT_DISCIPLINES = {"electrical", "lighting", "plumbing"}
ROOM_DISCIPLINES = {"architecture", "architecture_master", "construction", "demolition"}
STAGE_PCT = {"legend": 88, "detect": 91, "rooms": 96}
LINKS_FILE = "links.json.gz"
THUMB_PX = 256
MAX_DETECTIONS = 50_000

try:  # Worker-B's modules (feature-flagged: the stage still works without them)
    from ..rooms import assign_room
    from ..rooms import segment as rooms_segment
    from ..rooms.names import match_room_name

    HAVE_ROOMS = True
except ImportError:  # pragma: no cover - only before Worker-B's modules land
    HAVE_ROOMS = False
try:
    from ..lifecycle import classify as lifecycle_classify

    HAVE_LIFECYCLE = True
except ImportError:  # pragma: no cover
    HAVE_LIFECYCLE = False


def gz_json(obj: Any) -> bytes:
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)


# ------------------------------------------------------------------------------- mappings
def resolve_mapping(entry: LegendEntry, segs: np.ndarray | None, mappings: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """Remembered mapping for a legend entry: exact signature first, then its probe variants."""
    if not mappings:
        return None
    if entry.signature in mappings:
        return mappings[entry.signature]
    if segs is not None and len(segs):
        for sig in stroke_signatures(segs, entry.qualifier)[1:]:
            if sig in mappings:
                return mappings[sig]
    return None


# ------------------------------------------------------------------------------- outputs
def legend_json(
    res: LegendResult, sheet_id: str, thumbs: dict[str, str | None], applied: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    entries = []
    for e in res.entries:
        eid = e.entry_id(sheet_id)
        m = applied.get(eid)
        cls = (m or {}).get("class") or e.suggested_class
        entries.append(
            {
                "id": eid,
                "legendId": e.legend_id,
                "symbolBboxMm": bbox_dict(e.symbol_bbox),
                "labelBboxMm": bbox_dict(e.label_bbox or e.symbol_bbox),
                "label": e.label[:300],
                "labelConfidence": round(float(e.label_conf), 3),
                "suggestedClass": cls,
                "classConfidence": round(0.95 if m and m.get("class") else float(e.class_conf), 3),
                "signature": e.signature,
                "thumb": thumbs.get(eid),
            }
        )
    return {
        "schema": LEGEND_SCHEMA,
        "legends": [
            {"id": lg.id, "bboxMm": bbox_dict(lg.bbox), "title": lg.title, "confidence": round(lg.confidence, 3)}
            for lg in res.legends
        ],
        "entries": entries,
    }


def detection_stats(dets: list[dict[str, Any]]) -> dict[str, Any]:
    lv = Counter(d["level"] for d in dets)
    return {
        "total": len(dets),
        "green": lv.get("green", 0),
        "yellow": lv.get("yellow", 0),
        "red": lv.get("red", 0),
        "unknown": sum(1 for d in dets if d["class"] == "unknown"),
        "byClass": dict(sorted(Counter(d["class"] for d in dets).items())),
    }


def _crop(render: Callable[..., Any] | None, box: BBox, margin: float = 1.0) -> bytes | None:
    if render is None:
        return None
    x0, y0, x1, y1 = box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin
    w_mm, h_mm = max(x1 - x0, 0.5), max(y1 - y0, 0.5)
    ppm = min(THUMB_PX / w_mm, THUMB_PX / h_mm, 24.0)
    w, h = max(1, int(w_mm * ppm)), max(1, int(h_mm * ppm))
    try:
        img = render(ppm, max(0, int(x0 * ppm)), max(0, int(y0 * ppm)), w, h)
    except Exception:  # a crop is a convenience; never fail the stage for it
        log.warning("thumbnail render failed", exc_info=True)
        return None
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="WEBP", quality=82)
    return buf.getvalue()


def _open_render(
    kind: str, src_path: str | None, index: int, vs: VectorSheet
) -> tuple[Callable[..., Any] | None, Callable[[], None]]:
    if src_path is None:
        return None, lambda: None
    if kind == "pdf":
        from ..parse.pdf import PdfPageSource

        src = PdfPageSource.open(src_path, index)
        return src.render, src.close
    if kind in ("png", "jpg"):
        from ..parse.raster import RasterSource

        rs = RasterSource.open(src_path)
        return rs.render, lambda: None
    from ..parse.vectors import VectorPainter

    return VectorPainter([vs]).render, lambda: None


# ------------------------------------------------------------------------------- main
def understand(
    vs: VectorSheet,
    spans: list[TextSpan],
    *,
    sheet_id: str,
    discipline: str | None,
    scale_den: int | None,
    regions: list[dict[str, Any]],
    text_paths: set[int],
    raster: bool = False,
    render: Callable[..., Any] | None = None,
    mappings: dict[str, dict[str, Any]] | None = None,
    out_dir: Path | None = None,
    progress: Progress | None = None,
    detect: bool = True,
    rooms: bool = True,
    raster_image: Any = None,
    floors_confirmed: bool = False,
    links: bool = True,
) -> dict[str, Any]:
    """Run legend → detect → rooms → links on one sheet. Writes the artifacts into ``out_dir`` when given.

    ``floors_confirmed``: the user confirmed the sheet's floors / regions — they are used as is and
    no "קומה לא ודאית" reason is added."""
    from ..classify.sheet import classify_page

    mappings = mappings or {}
    prog = progress or (lambda st, pct: None)
    timings: dict[str, float] = {}
    t = time.monotonic()

    def lap(name: str) -> None:
        nonlocal t
        now = time.monotonic()
        timings[name] = round(now - t, 3)
        t = now

    prog("legend", STAGE_PCT["legend"])
    title_block = classify_page(spans, vs, raster=raster).title_block_bbox if (spans or vs.n_paths) else None
    legend = parse_legends(vs, spans, title_block=title_block, sheet_id=sheet_id)
    # remembered mappings / linked confirmed entries
    applied: dict[str, dict[str, Any]] = {}
    ignored: set[str] = set()
    for e in legend.entries:
        m = resolve_mapping(e, vs.segs[e.seg_idx].astype(np.float64) if len(e.seg_idx) else None, mappings)
        if m is None:
            continue
        eid = e.entry_id(sheet_id)
        applied[eid] = m
        if m.get("status") == "ignored":
            ignored.add(e.signature)
        if m.get("class"):
            e.suggested_class = str(m["class"])
            e.class_conf = 0.95
    lap("legend")

    # ---------------------------------------------------------------- detect
    prog("detect", STAGE_PCT["detect"])
    det: DetectResult = DetectResult()
    run_detect = detect and (discipline in DETECT_DISCIPLINES)
    if run_detect and not raster:
        sig_maps = {
            e.signature: {"class": e.suggested_class}
            for e in legend.entries
            if e.entry_id(sheet_id) in applied and e.suggested_class
        }
        det = detect_symbols(
            vs,
            spans,
            legend,
            title_block=title_block,
            discipline=discipline,
            regions=regions,
            scale_den=scale_den,
            mappings=sig_maps,
            text_paths=text_paths,
        )
        det.detections = [d for d in det.detections if not (d.entry is not None and d.entry.signature in ignored)]
    elif run_detect and raster and raster_image is not None:
        from ..symbols.raster import detect_raster

        det = detect_raster(
            raster_image,
            spans,
            width_mm=vs.width_mm,
            regions=regions,
            scale_den=scale_den,
            discipline=discipline,
            title_block=title_block,
        )
        legend = det.legend or legend
    lap("detect")

    # ---------------------------------------------------------------- rooms
    prog("rooms", STAGE_PCT["rooms"])
    room_objs: list[Any] = []
    has_names = HAVE_ROOMS and any(match_room_name(s.text) is not None for s in spans if len(s.text) <= 40)
    if rooms and HAVE_ROOMS and not raster and (discipline in ROOM_DISCIPLINES or has_names):
        try:
            room_objs = list(rooms_segment(vs, spans, regions, scale_den, exclude_paths=text_paths))
        except Exception:  # rooms are best effort; detections must still be written
            log.warning("rooms.segment failed", exc_info=True)
            room_objs = []
    _assign_rooms(det.detections, room_objs, regions)
    if not floors_confirmed:
        _flag_uncertain_floors(det.detections, room_objs, regions, spans, title_block)
    if HAVE_LIFECYCLE and det.detections:
        try:
            plan_spans = spans
            lc = lifecycle_classify(
                vs,
                [d.bbox for d in det.detections],
                {
                    "text": plan_spans,
                    "discipline": discipline,
                    "exclude_paths": sorted(text_paths),
                    # an MEP plan draws what is to be installed: new unless marked otherwise (low confidence)
                    **({"default": "new"} if discipline in DETECT_DISCIPLINES else {}),
                },
            )
            for d, r in zip(det.detections, lc, strict=False):
                d.lifecycle = r.lifecycle
                if r.lifecycle == "existing":
                    d.supply = "existing"
        except Exception:
            log.warning("lifecycle.classify failed", exc_info=True)
    lap("rooms")

    # ---------------------------------------------------------------- outputs
    dets_json = [d.to_json(sheet_id) for d in det.detections][:MAX_DETECTIONS]
    # link to a confirmed entry with the same signature on another sheet
    link = {
        eid: str(m["entryId"]) for eid, m in applied.items() if m.get("entryId") and m.get("status") in ("confirmed", "ignored")
    }
    for dj in dets_json:
        if dj["legendEntryId"] in link:
            dj["legendEntryId"] = link[dj["legendEntryId"]]
    clusters_json = [c.to_json() for c in det.clusters]
    rooms_json = {"schema": ROOMS_SCHEMA, "rooms": [r.to_json() for r in room_objs]}
    files: list[dict[str, str]] = []
    thumbs: dict[str, str | None] = {}
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        for e in legend.entries:
            eid = e.entry_id(sheet_id)
            box = e.symbol_bbox if e.label_bbox is None else _union(e.symbol_bbox, e.label_bbox)
            data = _crop(render, box)
            if data:
                rel = f"legend/{eid}.webp"
                (out_dir / "legend").mkdir(exist_ok=True)
                (out_dir / rel).write_bytes(data)
                files.append({"path": rel, "contentType": "image/webp"})
                thumbs[eid] = rel
            else:
                thumbs[eid] = None
        for cj, c in zip(clusters_json, det.clusters, strict=True):
            data = _crop(render, c.exemplar, 1.5)
            if data:
                rel = f"unknown/{c.id}.webp"
                (out_dir / "unknown").mkdir(exist_ok=True)
                (out_dir / rel).write_bytes(data)
                files.append({"path": rel, "contentType": "image/webp"})
            else:
                cj["thumb"] = None
    leg_json = legend_json(legend, sheet_id, thumbs, applied)
    det_doc = {"schema": DETECTIONS_SCHEMA, "detections": dets_json, "unknownClusters": clusters_json}
    # ---------------------------------------------------------------- links (lighting sheets)
    links_doc: dict[str, Any] | None = None
    link_stats: dict[str, Any] | None = None
    if links and run_detect and not raster and discipline in LINK_DISCIPLINES:
        prog("rooms", 98)  # no own progress stage in the contracts (VersionStage); still "rooms"
        exclude = [lg.bbox for lg in legend.legends] + ([title_block] if title_block else [])
        try:
            links_doc, link_stats = link_sheet(
                vs, spans, dets_json, leg_json, text_paths=text_paths, exclude=exclude, scale_den=scale_den
            )
        except Exception:  # links are best effort; the other artifacts must still be written
            log.warning("links failed", exc_info=True)
            links_doc = link_stats = None
    lap("links")
    if out_dir is not None:
        outs: list[tuple[str, Any]] = [
            ("legend.json.gz", leg_json),
            ("detections.json.gz", det_doc),
            ("rooms.json.gz", rooms_json),
        ]
        for name, obj in outs:
            (out_dir / name).write_bytes(gz_json(obj))
            files.append({"path": name, "contentType": "application/gzip"})
        if links_doc is not None:
            # reported under its own key (not ``files``): an orchestrator that does not know the
            # links artifact yet keeps working; one that does uploads ``linksFile`` → artifacts.links
            (out_dir / LINKS_FILE).write_bytes(gz_json(links_doc))
    lap("write")
    return {
        "legend": leg_json,
        "legendLinks": link,
        "detectionStats": detection_stats(dets_json),
        "rooms": len(room_objs),
        "legendEntries": len(leg_json["entries"]),
        "files": files,
        "timings": timings,
        "detectStats": det.stats,
        "detected": run_detect,
        **({"linkStats": link_stats} if link_stats is not None else {}),
        **({"linksFile": LINKS_FILE} if links_doc is not None and out_dir is not None else {}),
    }


def _union(a: BBox, b: BBox) -> BBox:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


FLOOR_LABEL_REACH_MM = 30.0


def floor_labels(spans: list[TextSpan], regions: list[dict[str, Any]], title_block: BBox | None) -> dict[str, list[str]]:
    """Floor names written next to each drawing ("קומה א'", "קומת מרתף"), per region id. Notes such
    as "קו קומה א'" (the floor line) or long sentences are not labels."""
    from shapely.geometry import Point, Polygon

    from ..classify.sheet import _floors_in_order

    out: dict[str, list[str]] = {}
    polys = {}
    for r in regions:
        pts = [(float(p["x"]), float(p["y"])) for p in r.get("polygonMm", [])]
        if len(pts) >= 3:
            polys[str(r.get("id"))] = Polygon(pts)
    for s in spans:
        t = s.text.strip()
        # a label names the floor and nothing else ("קומה א'", "קומת מרתף"); "במרתף" inside a note is not one
        if len(t) > 22 or "קו " in t or not (t.startswith("קומ") or t.strip(" :") == "מרתף"):
            continue
        cx, cy = (s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2
        if title_block and title_block[0] <= cx <= title_block[2] and title_block[1] <= cy <= title_block[3]:
            continue
        fl = _floors_in_order(t)
        if len(fl) != 1:
            continue
        near = sorted((poly.distance(Point(cx, cy)), rid) for rid, poly in polys.items())
        if near and near[0][0] <= FLOOR_LABEL_REACH_MM and not (len(near) > 1 and near[1][0] <= near[0][0] + 5.0):
            out.setdefault(near[0][1], []).append(fl[0])
    return out


def uncertain_floor_regions(spans: list[TextSpan], regions: list[dict[str, Any]], title_block: BBox | None) -> set[str]:
    """Regions whose floor is not confirmed by the drawing itself: several drawings on the sheet with
    floors assigned in title-block order and no agreeing label next to the drawing, or a label next to
    a drawing that names another floor. The title assignment is kept; the owner confirms."""
    labels = floor_labels(spans, regions, title_block)
    out: set[str] = set()
    for r in regions:
        rid, fl = str(r.get("id")), r.get("floor")
        lab = labels.get(rid, [])
        if lab and any(x != fl for x in lab) or len(regions) > 1 and fl not in lab:
            out.add(rid)
    return out


def _demote(reasons: list[str], level: str, reason: str) -> str:
    if reason not in reasons:
        reasons.append(reason)
    return "yellow" if level == "green" else level


def _flag_uncertain_floors(
    dets: list[Detection], rooms: list[Any], regions: list[dict[str, Any]], spans: list[TextSpan], title_block: BBox | None
) -> None:
    from shapely.geometry import Point, Polygon

    from ..symbols.detect import R_FLOOR

    bad = uncertain_floor_regions(spans, regions, title_block)
    if not bad:
        return
    polys = [
        Polygon([(float(p["x"]), float(p["y"])) for p in r["polygonMm"]]).buffer(0.5)
        for r in regions
        if str(r.get("id")) in bad and len(r.get("polygonMm", [])) >= 3
    ]

    def inside(x: float, y: float) -> bool:
        pt = Point(x, y)
        return any(p.contains(pt) for p in polys)

    for d in dets:
        if inside(*d.center):
            d.level = _demote(d.reasons, d.level, R_FLOOR)
    for r in rooms:
        pts = getattr(r, "polygon_mm", None) or []
        if pts:
            c = Polygon(pts).representative_point()
            if inside(c.x, c.y):
                r.level = _demote(r.reasons, r.level, R_FLOOR)


def _assign_rooms(dets: list[Detection], rooms: list[Any], regions: list[dict[str, Any]]) -> None:
    for d in dets:
        r = assign_room(rooms, d.center[0], d.center[1]) if (rooms and HAVE_ROOMS) else None
        if r is not None:
            d.room_id = r.id
            if r.floor:
                d.floor = r.floor


# ------------------------------------------------------------------------- sandbox entry
def run(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    """Sandbox task ``understand``. ``args``: kind, path (source, relative), index, pageDir (the page
    task's outDir, relative), outDir (relative), sheet, discipline, scaleDenominator, regions,
    mappings {signature: {class, itemCode, label, status, entryId}}, detect, rooms, links,
    floorsConfirmed (the sheet doc is ``confirmed``: regions' floors are authoritative)."""
    from ..classify.sheet import span_from_line
    from ..types_sprint2 import vector_sheet_from_primitives

    wd = Path.cwd().resolve()

    def inside(rel: str) -> Path:
        p = (wd / rel).resolve()
        if wd not in p.parents:
            raise ValueError("path escapes the sandbox directory")
        return p

    page_dir = inside(str(args["pageDir"]))
    out = inside(str(args["outDir"]))
    out.mkdir(parents=True, exist_ok=True)
    prim = decode_primitives((page_dir / "primitives.msgpack.gz").read_bytes())
    vs = vector_sheet_from_primitives(prim)
    text = decode_text((page_dir / "text.json.gz").read_bytes())
    spans = [span_from_line(ln) for ln in text.get("lines", [])]
    kind = str(args.get("kind", "pdf"))
    raster = kind in ("png", "jpg")
    render, close = _open_render(
        kind, str(inside(str(args["path"]))) if args.get("path") else None, int(args.get("index", 0)), vs
    )
    raster_image = None
    try:
        if raster and render is not None:
            from ..parse.raster import RasterSource

            raster_image = RasterSource.open(str(inside(str(args["path"])))).img
        res = understand(
            vs,
            spans,
            sheet_id=str(args.get("sheet", "")),
            discipline=args.get("discipline"),
            scale_den=int(args["scaleDenominator"]) if args.get("scaleDenominator") else None,
            regions=list(args.get("regions") or []),
            text_paths={int(i) for i in prim.get("textPaths", [])},
            raster=raster,
            render=render,
            mappings=dict(args.get("mappings") or {}),
            out_dir=out,
            progress=progress,
            detect=bool(args.get("detect", True)),
            rooms=bool(args.get("rooms", True)),
            raster_image=raster_image,
            floors_confirmed=bool(args.get("floorsConfirmed", False)),
            links=bool(args.get("links", True)),
        )
    finally:
        close()
    res["outDir"] = out.relative_to(wd).as_posix()
    return res


__all__ = [
    "DETECT_DISCIPLINES",
    "LINKS_FILE",
    "Detection",
    "apply_confirmed_floors",
    "detection_stats",
    "run",
    "score_detection",
    "understand",
]
