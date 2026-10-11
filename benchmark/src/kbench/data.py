"""Loading annotations / predictions (same on-disk layout for both).

Project directory layout::

    <dir>/sheets/<sheet_id>.geojson   # one FeatureCollection per sheet (paper mm, y down)
    <dir>/boq_truth.json | boq.json   # per-project BOQ (codes are TEXT)
    <dir>/disputes.json               # optional, truth only

Codes are kept as strings end-to-end; JSON numbers in a ``code`` field are rejected.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCHEMA_DIR = Path(os.environ.get("KBENCH_SCHEMA_DIR", Path(__file__).resolve().parents[2] / "schema"))

COUNT_UNITS = {"יחידה", "יח'", "יח", "unit", "pcs"}
AREA_UNITS = {'מ"ר', "מ״ר", "m2"}
LENGTH_UNITS = {'מ"א', "מ״א", "m"}
LUMP_UNITS = {"קומפלט", "lump"}


def unit_kind(unit: str) -> str:
    u = (unit or "").strip()
    if u in COUNT_UNITS:
        return "count"
    if u in AREA_UNITS:
        return "area"
    if u in LENGTH_UNITS:
        return "length"
    if u in LUMP_UNITS:
        return "lump_sum"
    return "other"


def load_classes() -> dict[str, dict[str, Any]]:
    with open(SCHEMA_DIR / "classes.json", encoding="utf-8") as f:
        return json.load(f)["classes"]


def class_domain(cls: str, classes: dict[str, dict[str, Any]] | None = None) -> str:
    classes = classes if classes is not None else load_classes()
    if cls in classes:
        return classes[cls]["domain"]
    for prefix, dom in (("socket", "electrical"), ("switch", "lighting"), ("luminaire", "lighting"),
                        ("fixture", "plumbing"), ("faucet", "plumbing")):
        if cls.startswith(prefix):
            return dom
    return "other"


def polygon_area(ring: list[list[float]]) -> float:
    """Shoelace area (absolute) of a closed or open ring."""
    n = len(ring)
    if n < 3:
        return 0.0
    s = 0.0
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2.0


@dataclass
class Feature:
    id: str
    sheet_id: str
    cls: str
    geom_type: str
    coords: Any
    props: dict[str, Any]
    bbox: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)

    def __post_init__(self) -> None:
        pts = _flatten(self.geom_type, self.coords)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))

    @property
    def center(self) -> tuple[float, float]:
        x0, y0, x1, y1 = self.bbox
        return ((x0 + x1) / 2.0, (y0 + y1) / 2.0)

    @property
    def size_mm(self) -> float:
        x0, y0, x1, y1 = self.bbox
        return max(x1 - x0, y1 - y0)

    @property
    def kind(self) -> str:
        return self.props.get("kind", "symbol")

    @property
    def area_mm2(self) -> float:
        if self.geom_type != "Polygon":
            return 0.0
        outer = polygon_area(self.coords[0])
        holes = sum(polygon_area(r) for r in self.coords[1:])
        return outer - holes

    def get(self, key: str, default: Any = None) -> Any:
        return self.props.get(key, default)


def _flatten(gtype: str, coords: Any) -> list[tuple[float, float]]:
    if gtype == "Point":
        return [(float(coords[0]), float(coords[1]))]
    if gtype == "LineString":
        return [(float(x), float(y)) for x, y in coords]
    if gtype == "Polygon":
        return [(float(x), float(y)) for ring in coords for x, y in ring]
    raise ValueError(f"unsupported geometry type {gtype}")


@dataclass
class Sheet:
    sheet_id: str
    meta: dict[str, Any]
    features: list[Feature]

    @property
    def scale(self) -> float | None:
        return self.meta.get("scale")


@dataclass
class Project:
    root: Path | None
    sheets: dict[str, Sheet] = field(default_factory=dict)
    boq: dict[str, Any] | None = None
    disputes: dict[str, Any] | None = None

    def all_features(self) -> list[Feature]:
        return [f for s in self.sheets.values() for f in s.features]

    def boq_lines(self) -> list[dict[str, Any]]:
        return list(self.boq.get("lines", [])) if self.boq else []

    def open_dispute_codes(self) -> set[str]:
        """Codes referenced by open disputes, plus lines flagged gt_status=disputed."""
        codes: set[str] = set()
        if self.disputes:
            for d in self.disputes.get("disputes", []):
                if d.get("status") not in ("resolved", "withdrawn"):
                    codes.update(d.get("lines", []))
        for ln in self.boq_lines():
            if ln.get("gt_status") == "disputed":
                codes.add(ln["code"])
        return codes


def sheet_from_geojson(obj: dict[str, Any], fallback_id: str = "") -> Sheet:
    meta = obj.get("kamutan", {})
    sid = meta.get("sheet_id") or fallback_id
    feats = []
    for raw in obj.get("features", []):
        p = raw["properties"]
        g = raw["geometry"]
        feats.append(Feature(id=str(p["id"]), sheet_id=sid, cls=p["class"], geom_type=g["type"],
                             coords=g["coordinates"], props=p))
    return Sheet(sheet_id=sid, meta=meta, features=feats)


def _check_codes(boq: dict[str, Any], path: Path) -> None:
    for key in ("lines", "change_orders"):
        for ln in boq.get(key, []):
            if not isinstance(ln.get("code"), str):
                raise ValueError(f"{path}: line code {ln.get('code')!r} must be a string (TEXT), not a number")


def load_project(root: str | Path) -> Project:
    root = Path(root)
    proj = Project(root=root)
    sheets_dir = root / "sheets"
    if sheets_dir.is_dir():
        for p in sorted(sheets_dir.glob("*.geojson")):
            with open(p, encoding="utf-8") as f:
                sh = sheet_from_geojson(json.load(f), fallback_id=p.stem)
            if sh.sheet_id in proj.sheets:
                raise ValueError(f"duplicate sheet id {sh.sheet_id} in {root}")
            proj.sheets[sh.sheet_id] = sh
    for name in ("boq_truth.json", "boq.json"):
        p = root / name
        if p.exists():
            with open(p, encoding="utf-8") as f:
                proj.boq = json.load(f)
            _check_codes(proj.boq, p)
            break
    p = root / "disputes.json"
    if p.exists():
        with open(p, encoding="utf-8") as f:
            proj.disputes = json.load(f)
    return proj
