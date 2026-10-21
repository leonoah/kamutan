"""Pure planning step of the marked PDF: BOQ lines + evidence + per-version artifacts → a JSON overlay plan.

Runs in the orchestrator on worker-made JSON (no customer file is parsed here); the sandbox task
(:mod:`.render`) turns the plan into PDF pages. All geometry is paper millimetres, y down, in the frame of the
version (``page.widthMm × page.heightMm``, rotation applied) — the same frame as detections / rooms / links.

Plan (``kamutan.marked-plan/1``)::

    {schema, options {legend, floorSplit, watermark, hideTitleBlock}, meta {buildId, date, stale},
     floors [floor…], lines [{id, code, description, qty, unit, level, colour, byFloor, marks}],
     pages [{sheetId, versionId, title, discipline, floors, widthMm, heightMm, regions [[x0,y0,x1,y1]…],
             titleBlockMm [x0,y0,x1,y1] | null, source {…set by the job…},
             marks [{lines [i…], x, y, w, h, level}], arcs [{line i, a [x,y], b [x,y]}],
             areas [{line i, poly [[x,y]…], k}], legend [[i, count]…]}],
     stats {marks, arcs, areas, stale, unresolved}}
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from .palette import line_colour, norm_level

PLAN_SCHEMA = "kamutan.marked-plan/1"
FLOOR_ORDER = ("basement", "ground", "first", "second", "third", "fourth", "roof")
FLOOR_LABELS = {
    "basement": "מרתף",
    "ground": "קומת קרקע",
    "first": "קומה א'",
    "second": "קומה ב'",
    "third": "קומה ג'",
    "fourth": "קומה ד'",
    "roof": "גג",
}
DISCIPLINE_ORDER = (
    "electrical",
    "lighting",
    "plumbing",
    "architecture_master",
    "architecture",
    "construction",
    "demolition",
)
MANUAL_BOX_MM = 6.0
MAX_MARKS_PER_PAGE = 20_000
_CODE_KEY = re.compile(r"\d+|\D+")


def code_key(code: str) -> tuple[Any, ...]:
    return tuple((0, int(p)) if p.isdigit() else (1, p) for p in _CODE_KEY.findall(code or ""))


def floor_key(f: str | None) -> tuple[int, str]:
    if f in FLOOR_ORDER:
        return (FLOOR_ORDER.index(f), "")
    return (len(FLOOR_ORDER), str(f or "~"))


def floor_label(f: str | None) -> str:
    if not f:
        return "ללא קומה"
    return FLOOR_LABELS.get(f, f)


@dataclass
class SheetArtifacts:
    """Everything the planner needs about one current sheet version (docs + worker JSON artifacts)."""

    sheet_id: str
    version_id: str
    title: str
    discipline: str
    floors: list[str]
    width_mm: float
    height_mm: float
    regions: list[dict[str, Any]] = field(default_factory=list)
    detections: dict[str, dict[str, Any]] = field(default_factory=dict)
    rooms: dict[str, dict[str, Any]] = field(default_factory=dict)
    links: dict[str, dict[str, Any]] = field(default_factory=dict)
    title_block_mm: tuple[float, float, float, float] | None = None


def _f(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) and abs(x) < 1e5 else None


def _bbox(d: dict[str, Any]) -> tuple[float, float, float, float] | None:
    b = d.get("bboxMm")
    if isinstance(b, dict):
        x, y, w, h = _f(b.get("x")), _f(b.get("y")), _f(b.get("w")), _f(b.get("h"))
        if None not in (x, y, w, h) and w > 0 and h > 0:  # type: ignore[operator]
            return (x, y, w, h)  # type: ignore[return-value]
    c = d.get("centerMm")
    if isinstance(c, dict):
        x, y = _f(c.get("x")), _f(c.get("y"))
        if x is not None and y is not None:
            return (x - MANUAL_BOX_MM / 2, y - MANUAL_BOX_MM / 2, MANUAL_BOX_MM, MANUAL_BOX_MM)
    return None


def _center(d: dict[str, Any]) -> tuple[float, float] | None:
    c = d.get("centerMm")
    if isinstance(c, dict):
        x, y = _f(c.get("x")), _f(c.get("y"))
        if x is not None and y is not None:
            return (x, y)
    b = _bbox(d)
    return (b[0] + b[2] / 2, b[1] + b[3] / 2) if b else None


def _poly(pts: Any) -> list[list[float]] | None:
    if not isinstance(pts, list) or len(pts) < 3:
        return None
    out: list[list[float]] = []
    for p in pts[:4000]:
        if isinstance(p, dict):
            x, y = _f(p.get("x")), _f(p.get("y"))
        elif isinstance(p, list | tuple) and len(p) >= 2:
            x, y = _f(p[0]), _f(p[1])
        else:
            return None
        if x is None or y is None:
            return None
        out.append([round(x, 3), round(y, 3)])
    return out


def _points(pts: Any) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for p in pts if isinstance(pts, list) else []:
        if isinstance(p, dict):
            x, y = _f(p.get("x")), _f(p.get("y"))
            if x is not None and y is not None:
                out.append((x, y))
    return out


def _qty(line: dict[str, Any]) -> float:
    o = line.get("qtyOverride")
    v = _f(o) if o is not None else _f(line.get("qty"))
    return float(v or 0.0)


def _manual_geometry(corr: dict[str, Any], det_id: str) -> tuple[str, Any] | None:
    """Geometry of a manual (correction-made) evidence item: ``("mark", bbox)`` or ``("area", poly)``."""
    geo = corr.get("geometry") if isinstance(corr.get("geometry"), dict) else None
    if geo is not None:
        if geo.get("type") == "polygon":
            p = _poly(geo.get("mm"))
            if p:
                return ("area", p)
        pts = _points(geo.get("mm"))
        if pts:
            m = re.search(r"_(\d+)$", det_id)
            i = int(m.group(1)) - 1 if m else 0
            x, y = pts[i] if 0 <= i < len(pts) else pts[0]
            return ("mark", (x - MANUAL_BOX_MM / 2, y - MANUAL_BOX_MM / 2, MANUAL_BOX_MM, MANUAL_BOX_MM))
    a = corr.get("anchorMm")
    if isinstance(a, dict):
        ax, ay = _f(a.get("x")), _f(a.get("y"))
        if ax is not None and ay is not None:
            return ("mark", (ax - MANUAL_BOX_MM / 2, ay - MANUAL_BOX_MM / 2, MANUAL_BOX_MM, MANUAL_BOX_MM))
    return None


def _chain(points: list[tuple[float, float]]) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Greedy nearest-neighbour chain through the luminaire points (one arc per hop)."""
    if len(points) < 2:
        return []
    rest = sorted(points)
    cur = rest.pop(0)
    out = []
    while rest:
        j = min(range(len(rest)), key=lambda k: (rest[k][0] - cur[0]) ** 2 + (rest[k][1] - cur[1]) ** 2)
        nxt = rest.pop(j)
        out.append((cur, nxt))
        cur = nxt
    return out


def _region_boxes(regions: list[dict[str, Any]]) -> list[list[float]]:
    out: list[list[float]] = []
    for r in regions:
        pts = _points(r.get("polygonMm"))
        if pts:
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            out.append([round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)])
    return out


def sheet_order(s: SheetArtifacts, floor_split: bool) -> tuple[Any, ...]:
    fk = min((floor_key(f) for f in s.floors), default=floor_key(None))
    dk = DISCIPLINE_ORDER.index(s.discipline) if s.discipline in DISCIPLINE_ORDER else len(DISCIPLINE_ORDER)
    return (fk, dk, s.sheet_id) if floor_split else (dk, fk, s.sheet_id)


def build_plan(
    sheets: list[SheetArtifacts],
    lines: dict[str, dict[str, Any]],
    evidence: dict[str, list[dict[str, Any]]],
    corrections: dict[str, dict[str, Any]],
    *,
    options: dict[str, Any],
    meta: dict[str, Any],
) -> dict[str, Any]:
    floor_split = bool(options.get("floorSplit"))
    ordered_ids = sorted(lines, key=lambda lid: (code_key(str(lines[lid].get("code") or "")), lid))
    index = {lid: i for i, lid in enumerate(ordered_ids)}
    floors: set[str] = set()
    plan_lines: list[dict[str, Any]] = []
    for lid in ordered_ids:
        ln = lines[lid]
        code = str(ln.get("code") or "")
        by_floor = (
            {str(k): float(_f(v) or 0.0) for k, v in (ln.get("byFloor") or {}).items()}
            if isinstance(ln.get("byFloor"), dict)
            else {}
        )
        floors.update(k for k, v in by_floor.items() if v)
        plan_lines.append(
            {
                "id": lid,
                "code": code[:32],
                "description": str(ln.get("description") or "")[:300],
                "qty": round(_qty(ln), 3),
                "overridden": ln.get("qtyOverride") is not None,
                "unit": str(ln.get("unit") or "")[:24],
                "level": norm_level(ln.get("level")),
                "status": str(ln.get("status") or "draft")[:16],
                "colour": line_colour(code),
                "byFloor": by_floor,
                "marks": 0,
            }
        )
    by_sheet = {s.sheet_id: s for s in sheets}
    pages: dict[str, dict[str, Any]] = {}
    for s in sheets:
        pages[s.sheet_id] = {
            "sheetId": s.sheet_id,
            "versionId": s.version_id,
            "title": s.title[:200],
            "discipline": s.discipline,
            "floors": list(s.floors),
            "widthMm": round(s.width_mm, 3),
            "heightMm": round(s.height_mm, 3),
            "regions": _region_boxes(s.regions),
            "titleBlockMm": [round(v, 2) for v in s.title_block_mm] if s.title_block_mm else None,
            "marks": [],
            "arcs": [],
            "areas": [],
            "legend": [],
        }
    stats = {"marks": 0, "arcs": 0, "areas": 0, "stale": 0, "unresolved": 0}
    mark_slots: dict[tuple[str, str], dict[str, Any]] = {}  # (sheet, detection) → mark (shared by several lines)
    room_k: dict[tuple[str, str], int] = {}
    seen_groups: set[tuple[str, str, int]] = set()
    seen_areas: set[tuple[str, str, int]] = set()
    page_counts: dict[str, dict[int, int]] = {sid: {} for sid in pages}
    for lid in ordered_ids:
        li = index[lid]
        for it in evidence.get(lid) or []:
            if not isinstance(it, dict):
                continue
            sid = str(it.get("sheetId") or "")
            if sid not in by_sheet:
                continue  # sheet not exported
            s = by_sheet[sid]
            if str(it.get("versionId") or "") != s.version_id:
                stats["stale"] += 1
                continue
            page = pages[sid]
            det_id = str(it.get("detectionId") or "")
            manual = bool(it.get("verified")) or it.get("source") == "manual"
            det = s.detections.get(det_id)
            counted = False
            if det is not None:
                b = _bbox(det)
                if b is not None:
                    key = (sid, det_id)
                    m = mark_slots.get(key)
                    if m is None:
                        m = {
                            "lines": [li],
                            "x": round(b[0], 3),
                            "y": round(b[1], 3),
                            "w": round(b[2], 3),
                            "h": round(b[3], 3),
                            "level": norm_level(det.get("level"), manual=manual),
                        }
                        mark_slots[key] = m
                        page["marks"].append(m)
                        stats["marks"] += 1
                    elif li not in m["lines"]:
                        m["lines"].append(li)
                        if manual:
                            m["level"] = "manual"
                    counted = True
            elif det_id in s.rooms:
                room = s.rooms[det_id]
                p = _poly(room.get("polygonMm"))
                if p is not None:
                    if (sid, det_id, li) not in seen_areas:
                        seen_areas.add((sid, det_id, li))
                        k = room_k.get((sid, det_id), 0)
                        room_k[(sid, det_id)] = k + 1
                        page["areas"].append(
                            {"line": li, "poly": p, "k": k, "level": norm_level(room.get("level"), manual=manual)}
                        )
                        stats["areas"] += 1
                    counted = True
            elif it.get("correctionId") and isinstance(corrections.get(str(it["correctionId"])), dict):
                g = _manual_geometry(corrections[str(it["correctionId"])], det_id)
                if g is not None and g[0] == "area":
                    key3 = (sid, f"c:{it['correctionId']}", li)
                    if key3 not in seen_areas:
                        seen_areas.add(key3)
                        page["areas"].append({"line": li, "poly": g[1], "k": 0, "level": "manual"})
                        stats["areas"] += 1
                    counted = True
                elif g is not None:
                    b = g[1]
                    m = {"lines": [li], "x": round(b[0], 3), "y": round(b[1], 3), "w": b[2], "h": b[3], "level": "manual"}
                    page["marks"].append(m)
                    stats["marks"] += 1
                    counted = True
            if not counted:
                stats["unresolved"] += 1
                continue
            page_counts[sid][li] = page_counts[sid].get(li, 0) + 1
            plan_lines[li]["marks"] += 1
            gid = it.get("linkGroupId")
            if isinstance(gid, str) and gid in s.links and (sid, gid, li) not in seen_groups:
                seen_groups.add((sid, gid, li))
                arcs = _group_arcs(s, s.links[gid])
                page["arcs"].extend(
                    {"line": li, "a": [round(a[0], 3), round(a[1], 3)], "b": [round(b[0], 3), round(b[1], 3)]} for a, b in arcs
                )
                stats["arcs"] += len(arcs)
    out_pages = []
    for s in sorted(sheets, key=lambda x: sheet_order(x, floor_split)):
        page = pages[s.sheet_id]
        page["marks"] = page["marks"][:MAX_MARKS_PER_PAGE]
        page["legend"] = [[li, n] for li, n in sorted(page_counts[s.sheet_id].items())]
        out_pages.append(page)
    return {
        "schema": PLAN_SCHEMA,
        "options": {
            "legend": bool(options.get("legend", True)),
            "floorSplit": floor_split,
            "watermark": options.get("watermark"),
            "hideTitleBlock": bool(options.get("hideTitleBlock")),
        },
        "meta": meta,
        "floors": sorted(floors, key=floor_key),
        "floorLabels": {f: floor_label(f) for f in floors},
        "lines": plan_lines,
        "pages": out_pages,
        "stats": stats,
    }


def _group_arcs(s: SheetArtifacts, g: dict[str, Any]) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    lum = [c for c in (_center(s.detections[i]) for i in g.get("luminaireIds") or [] if i in s.detections) if c]
    sw = [c for c in (_center(s.detections[i]) for i in g.get("switchIds") or [] if i in s.detections) if c]
    out = _chain(lum)
    for c in sw:
        if lum:
            n = min(lum, key=lambda p: (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2)
            out.append((c, n))
    return out[:256]


__all__ = ["FLOOR_LABELS", "PLAN_SCHEMA", "SheetArtifacts", "build_plan", "code_key", "floor_label"]
