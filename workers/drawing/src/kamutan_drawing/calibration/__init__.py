"""Confidence calibration (Sprint 5, FR-20, test plan §Calibration) — one helper for every producer of a level.

The table ``table.json`` (schema ``kamutan.calibration/1``, :file:`schema.json`) holds *class statistics only*
(n / tp / fp / precision / Wilson LB / greenAllowed / isotonic ``scoreMap``) measured on the DEV ground truth —
never holdout, never customer content. Until 30 GT projects exist the product runs in **conservative** mode:
a class may be green only when the table says ``greenAllowed`` (≥ 200 dev items with precision 1.0); every
other class is capped at yellow with :data:`R_CONSERVATIVE`.

:func:`calibrate` is the single entry point (detections, fixtures, link groups, rooms)::

    score, level, reasons = calibrate("socket_single", raw_score, reasons, level=heuristic_level)

* ``score`` = the class's isotonic ``scoreMap`` applied to ``raw_score`` (identity when the class has none);
  the producer keeps ``raw_score`` as ``scoreRaw``.
* ``level`` never becomes *more* permissive than the producer's heuristic ``level`` (when given): it is the
  minimum of that level and the level of the calibrated score; then the hard ceilings — ``raster`` (or a
  ``רסטר`` reason) is never green, a green class the table does not allow becomes yellow (+ the reason), a
  wilsonLb under the org's ``green_threshold`` becomes yellow (+ :data:`R_ORG_THRESHOLD`).
* ``human=True`` (accepted / corrected by a person) stays green with :data:`R_HUMAN`.
* a non-green result always carries ≥ 1 reason.

Class keys: detection classes as in contracts ``DetectionClass`` (fixtures included), ``link:<kind>`` for link
groups (:func:`link_key`), ``room`` for rooms. A key missing from the table is treated as *not allowed*.

The table is validated (JSON schema + semantic rules) when loaded; an invalid / missing table logs an error
and falls back to an empty conservative table (no green at all — fail closed, never fail the page).
``KAMUTAN_CALIBRATION_TABLE`` points the worker at another table file (tests, Data/QA's ``kbench calibrate``).
"""

from __future__ import annotations

import bisect
import itertools
import json
import logging
import math
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SCHEMA_ID = "kamutan.calibration/1"
HERE = Path(__file__).resolve().parent
TABLE_PATH = HERE / "table.json"
SCHEMA_PATH = HERE / "schema.json"
ENV_TABLE = "KAMUTAN_CALIBRATION_TABLE"

# ---- reason chips (Hebrew, user facing)
R_CONSERVATIVE = "כיול שמרני: אין מספיק נתוני אמת לסוג זה"
R_ORG_THRESHOLD = "כיול: מתחת לסף הירוק של הארגון"
R_CALIBRATED_LOW = "ביטחון נמוך לאחר כיול"
R_HUMAN = "אושר ידנית"
R_RASTER = "רסטר"

GREEN_MIN = 0.85  # brief level rule (contracts LEVEL_THRESHOLDS)
RED_BELOW = 0.5
LEVEL_RANK = {"red": 0, "yellow": 1, "green": 2}
# conservative eligibility rule (test plan): ≥ 200 dev items, precision 1.0
CONSERVATIVE_MIN_N = 200
# org setting greenThreshold (FR-31): default and allowed range
GREEN_THRESHOLD_DEFAULT = 0.98
GREEN_THRESHOLD_RANGE = (0.9, 0.995)
FALLBACK_VERSION = "fallback-empty"


class CalibrationError(ValueError):
    """The calibration table is invalid (schema or semantic rule)."""


@dataclass(frozen=True)
class ClassStats:
    n: int
    tp: int
    fp: int
    precision: float | None
    wilson_lb: float | None
    green_allowed: bool
    score_map: tuple[tuple[float, float], ...] | None = None

    def map_score(self, raw: float) -> float:
        """Monotone piecewise-linear interpolation through the isotonic knots, clamped at both ends."""
        raw = _clamp01(raw)
        m = self.score_map
        if not m:
            return raw
        xs = [p[0] for p in m]
        i = bisect.bisect_right(xs, raw)
        if i == 0:
            return m[0][1]
        if i >= len(m):
            return m[-1][1]
        (x0, y0), (x1, y1) = m[i - 1], m[i]
        if x1 <= x0:
            return y1
        return _clamp01(y0 + (y1 - y0) * (raw - x0) / (x1 - x0))

    def to_json(self) -> dict[str, Any]:
        return {
            "n": self.n,
            "tp": self.tp,
            "fp": self.fp,
            "precision": self.precision,
            "wilsonLb": self.wilson_lb,
            "greenAllowed": self.green_allowed,
            "scoreMap": [list(p) for p in self.score_map] if self.score_map else None,
        }


@dataclass(frozen=True)
class Calibrated:
    score: float
    level: str
    reasons: list[str]
    score_raw: float
    capped: bool = False  # the table / ceiling lowered the producer's green


@dataclass(frozen=True)
class CalibrationTable:
    version: str
    mode: str
    generated_at: str
    gt_version: str | None
    classes: Mapping[str, ClassStats] = field(default_factory=dict)
    domains: Mapping[str, ClassStats] = field(default_factory=dict)

    def stats(self) -> dict[str, str]:
        """``stats.calibration`` of a version doc / BOQ build."""
        return {"mode": self.mode, "version": self.version}

    def lookup(self, cls: str) -> ClassStats | None:
        return self.classes.get(cls)

    def score_stats(self, cls: str) -> ClassStats | None:
        """Stats whose ``scoreMap`` applies to ``cls``: the class's own map, else its domain's map (Data/QA's request:
        few classes reach the map threshold on one DEV project; the domain map lowers the cross-validated ECE). Green
        eligibility is always decided by the class entry alone (:meth:`green_allowed`)."""
        st = self.classes.get(cls)
        if st is not None and st.score_map:
            return st
        dom = domain_of(cls)
        ds = self.domains.get(dom) if dom else None
        if ds is not None and ds.score_map:
            return ds
        return st

    def green_allowed(self, cls: str, green_threshold: float | None = None) -> tuple[bool, str | None]:
        """(allowed, reason when not). A class missing from the table is never allowed."""
        st = self.classes.get(cls)
        if st is None or not st.green_allowed:
            return False, R_CONSERVATIVE
        if green_threshold is not None and (st.wilson_lb is None or st.wilson_lb < green_threshold):
            return False, R_ORG_THRESHOLD
        return True, None

    def calibrate(
        self,
        cls: str,
        raw_score: float,
        reasons: Sequence[str] = (),
        *,
        level: str | None = None,
        raster: bool = False,
        human: bool = False,
        green_threshold: float | None = None,
        warn: bool | None = None,
    ) -> Calibrated:
        raw = _clamp01(raw_score)
        out = list(dict.fromkeys(str(r) for r in reasons))
        st = self.score_stats(cls)
        score = st.map_score(raw) if st is not None else raw
        if human:
            if R_HUMAN not in out:
                out.append(R_HUMAN)
            return Calibrated(round(score, 4), "green", out, raw)
        has_warn = bool(out) if warn is None else warn
        heur = level if level in LEVEL_RANK else _level_for(raw, has_warn)
        lv = heur
        if st is not None and st.score_map:
            by_score = _level_for(score, False)
            if LEVEL_RANK[by_score] < LEVEL_RANK[lv]:
                lv = by_score
                if R_CALIBRATED_LOW not in out:
                    out.append(R_CALIBRATED_LOW)
        capped = False
        if lv == "green" and (raster or R_RASTER in out):
            lv, capped = "yellow", True
            if R_RASTER not in out:
                out.append(R_RASTER)
        if lv == "green":
            ok, why = self.green_allowed(cls, green_threshold)
            if not ok:
                lv, capped = "yellow", True
                if why and why not in out:
                    out.append(why)
        if lv != "green" and not out:
            out.append(R_CALIBRATED_LOW)
        return Calibrated(round(score, 4), lv, out, raw, capped)


_ELECTRICAL: tuple[str, ...] = (
    *("socket", "data_", "tv_", "phone_", "speaker", "intercom", "doorbell", "heater_feed", "water_heater"),
    *("panel", "breaker", "bezek", "conduit", "waterproof"),
)
_LIGHTING = ("switch", "luminaire", "ceiling_fan")
_PLUMBING = ("fixture_", "faucet_", "garden_tap", "ac_unit")  # AC drain points are BOQ chapter 03 (pooled, as kbench)


def domain_of(cls: str) -> str | None:
    """Brief domain (electrical | lighting | plumbing | tiling) of a class key (benchmark/schema/classes.json)."""
    if cls.startswith("link:"):
        return "lighting"
    if cls == ROOM_KEY:
        return "tiling"
    for dom, prefixes in (("electrical", _ELECTRICAL), ("lighting", _LIGHTING), ("plumbing", _PLUMBING)):
        if cls.startswith(prefixes):
            return dom
    return None


def _clamp01(v: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(f):
        return 0.0
    return max(0.0, min(1.0, f))


def _level_for(score: float, warn: bool) -> str:
    if score < RED_BELOW:
        return "red"
    if score >= GREEN_MIN and not warn:
        return "green"
    return "yellow"


def min_level(*levels: str) -> str:
    return min(levels, key=lambda lv: LEVEL_RANK.get(lv, 0)) if levels else "green"


def link_key(kind: str | None) -> str:
    return f"link:{kind or 'unknown'}"


ROOM_KEY = "room"


# ------------------------------------------------------------------------------------------- loading / validation
@cache
def _schema() -> dict[str, Any]:
    s: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return s


def _stats(raw: Mapping[str, Any], where: str, mode: str) -> ClassStats:
    n, tp, fp = int(raw["n"]), int(raw["tp"]), int(raw["fp"])
    if tp + fp != n:
        raise CalibrationError(f"{where}: tp + fp != n")
    sm = raw.get("scoreMap")
    pts: tuple[tuple[float, float], ...] | None = None
    if sm:
        pts = tuple((float(a), float(b)) for a, b in sm)
        for (x0, y0), (x1, y1) in itertools.pairwise(pts):
            if x1 < x0 or y1 < y0:
                raise CalibrationError(f"{where}: scoreMap must be non-decreasing in raw and calibrated score")
    allowed = bool(raw["greenAllowed"])
    if allowed and mode == "conservative" and (n < CONSERVATIVE_MIN_N or fp != 0):
        raise CalibrationError(f"{where}: greenAllowed needs n >= {CONSERVATIVE_MIN_N} and precision 1.0 in conservative mode")
    prec = raw.get("precision")
    lb = raw.get("wilsonLb")
    return ClassStats(n, tp, fp, None if prec is None else float(prec), None if lb is None else float(lb), allowed, pts)


def parse_table(doc: Mapping[str, Any]) -> CalibrationTable:
    """Validate a ``kamutan.calibration/1`` document (JSON schema + semantic rules) → :class:`CalibrationTable`."""
    import jsonschema

    try:
        jsonschema.validate(dict(doc), _schema())
    except jsonschema.ValidationError as e:
        raise CalibrationError(f"calibration table: {e.message}") from None
    mode = str(doc["mode"])
    classes = {str(k): _stats(v, f"classes.{k}", mode) for k, v in doc["classes"].items()}
    domains = {str(k): _stats(v, f"domains.{k}", mode) for k, v in doc["domains"].items()}
    return CalibrationTable(
        version=str(doc["version"]),
        mode=mode,
        generated_at=str(doc["generatedAt"]),
        gt_version=doc.get("gtVersion"),
        classes=classes,
        domains=domains,
    )


def fallback_table() -> CalibrationTable:
    """No (valid) table: conservative, nothing allowed green."""
    return CalibrationTable(version=FALLBACK_VERSION, mode="conservative", generated_at="", gt_version=None)


def load_table(path: str | Path | None = None) -> CalibrationTable:
    """Read + validate a table file. Raises :class:`CalibrationError` / ``OSError``."""
    p = Path(path) if path is not None else Path(os.environ.get(ENV_TABLE) or TABLE_PATH)
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise CalibrationError(f"calibration table is not JSON ({e.msg})") from None
    if not isinstance(doc, dict):
        raise CalibrationError("calibration table must be an object")
    return parse_table(doc)


_current: CalibrationTable | None = None


def default_table() -> CalibrationTable:
    """The process-wide table (loaded once; fail closed to :func:`fallback_table`)."""
    global _current
    if _current is None:
        try:
            _current = load_table()
        except (OSError, CalibrationError) as e:
            log.error("calibration table unusable (%s); conservative fallback, no class may be green", e)
            _current = fallback_table()
    return _current


def set_default_table(table: CalibrationTable | None) -> None:
    """Replace (or with ``None`` reset) the process-wide table — tests, a table pushed by the orchestrator."""
    global _current
    _current = table


def calibrate(
    cls: str,
    raw_score: float,
    reasons: Sequence[str] = (),
    *,
    level: str | None = None,
    raster: bool = False,
    human: bool = False,
    green_threshold: float | None = None,
    warn: bool | None = None,
    table: CalibrationTable | None = None,
) -> tuple[float, str, list[str]]:
    """``(score, level, reasons)`` for one item — see the module docstring. Shared by every producer of a level
    (Worker-B's fixtures may call it directly; the understand stage also applies it to their records)."""
    c = (table or default_table()).calibrate(
        cls, raw_score, reasons, level=level, raster=raster, human=human, green_threshold=green_threshold, warn=warn
    )
    return c.score, c.level, c.reasons


def clean_green_threshold(v: Any) -> float | None:
    """Org setting ``greenThreshold`` (0.9–0.995) or ``None`` (absent / invalid → table rule only)."""
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    f = float(v)
    lo, hi = GREEN_THRESHOLD_RANGE
    return f if lo <= f <= hi else None


# ------------------------------------------------------------------------------------------- building a table
def wilson_lower(k: int, n: int, z: float = 1.96) -> float | None:
    """Two-sided Wilson score interval, lower bound (test plan formula)."""
    if n <= 0:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (centre - half) / den)


def isotonic(points: Iterable[tuple[float, bool]], *, max_knots: int = 64) -> list[list[float]] | None:
    """Pool-adjacent-violators fit of P(correct | raw score) → knots ``[[raw, calibrated], …]`` (raw = block mean),
    non-decreasing in both coordinates. ``None`` when fewer than 2 distinct blocks remain."""
    pts = sorted((_clamp01(s), 1.0 if ok else 0.0) for s, ok in points)
    if not pts:
        return None
    blocks: list[list[float]] = []  # [sum_x, sum_y, count]
    for x, y in pts:
        blocks.append([x, y, 1.0])
        while len(blocks) >= 2 and blocks[-2][1] / blocks[-2][2] > blocks[-1][1] / blocks[-1][2]:
            b = blocks.pop()
            blocks[-1] = [blocks[-1][0] + b[0], blocks[-1][1] + b[1], blocks[-1][2] + b[2]]
    knots = [[round(b[0] / b[2], 4), round(b[1] / b[2], 4)] for b in blocks]
    while len(knots) > max_knots:  # merge the closest pair of neighbours (keeps monotonicity)
        i = min(range(len(knots) - 1), key=lambda j: knots[j + 1][0] - knots[j][0])
        a, b = knots[i], knots.pop(i + 1)
        knots[i] = [round((a[0] + b[0]) / 2, 4), round((a[1] + b[1]) / 2, 4)]
    dedup: list[list[float]] = []
    for k in knots:
        if dedup and k[0] <= dedup[-1][0]:
            dedup[-1][1] = max(dedup[-1][1], k[1])
            continue
        dedup.append(k)
    return dedup if len(dedup) >= 2 else None


@dataclass(frozen=True)
class Record:
    """One predicted item of the DEV evaluation: class key, domain, raw score, detection-correct."""

    cls: str
    domain: str
    score: float | None
    correct: bool


def class_stats(records: Sequence[Record], *, mode: str, min_map_n: int) -> dict[str, Any]:
    n = len(records)
    tp = sum(1 for r in records if r.correct)
    fp = n - tp
    allowed = n >= CONSERVATIVE_MIN_N and fp == 0 if mode == "conservative" else False
    scored = [(float(r.score), r.correct) for r in records if r.score is not None]
    smap = isotonic(scored) if len(scored) >= min_map_n else None
    lb = wilson_lower(tp, n)
    return {
        "n": n,
        "tp": tp,
        "fp": fp,
        "precision": round(tp / n, 4) if n else None,
        "wilsonLb": round(lb, 4) if lb is not None else None,
        "greenAllowed": allowed,
        "scoreMap": smap,
    }


def build_table(
    records: Sequence[Record],
    *,
    version: str,
    generated_at: str,
    gt_version: str | None,
    mode: str = "conservative",
    min_map_n: int = 100,
    source: str = "",
) -> dict[str, Any]:
    """A ``kamutan.calibration/1`` document from DEV evaluation records (class statistics only)."""
    by_cls: dict[str, list[Record]] = {}
    by_dom: dict[str, list[Record]] = {}
    for r in records:
        by_cls.setdefault(r.cls, []).append(r)
        by_dom.setdefault(r.domain, []).append(r)
    doc = {
        "schema": SCHEMA_ID,
        "version": version,
        "mode": mode,
        "generatedAt": generated_at,
        "gtVersion": gt_version,
        "source": source[:300],
        "rule": (
            f"conservative: greenAllowed only for classes with >= {CONSERVATIVE_MIN_N} DEV items and precision 1.0; "
            f"scoreMap = isotonic P(correct | raw score) on DEV (>= {min_map_n} scored items), never holdout"
        ),
        "classes": {k: class_stats(v, mode=mode, min_map_n=min_map_n) for k, v in sorted(by_cls.items())},
        "domains": {k: class_stats(v, mode=mode, min_map_n=min_map_n) for k, v in sorted(by_dom.items())},
    }
    parse_table(doc)  # never emit an invalid table
    return doc


__all__ = [
    "ROOM_KEY",
    "R_CALIBRATED_LOW",
    "R_CONSERVATIVE",
    "R_HUMAN",
    "R_ORG_THRESHOLD",
    "SCHEMA_ID",
    "Calibrated",
    "CalibrationError",
    "CalibrationTable",
    "ClassStats",
    "Record",
    "build_table",
    "calibrate",
    "class_stats",
    "clean_green_threshold",
    "default_table",
    "fallback_table",
    "isotonic",
    "link_key",
    "load_table",
    "min_level",
    "parse_table",
    "set_default_table",
    "wilson_lower",
]
