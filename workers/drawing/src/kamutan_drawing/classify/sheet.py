"""Sheet classification: discipline, floors, title, scale — with confidence, level and reasons.

Sources, in order: the title block (label cells, :mod:`kamutan_drawing.titleblock`), else
the largest text on the sheet that names a discipline. The declared scale is cross-checked
against dimension strings (:mod:`kamutan_drawing.scale.detect`). Reasons are Hebrew, shown
to the user as-is. Level: green ≥ 0.85 with no warning, red < 0.5 or no discipline, else
yellow; rasters are capped at yellow.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from ..ingest.pdf_vector import VectorSheet
from ..ocr.dictionary import TextSpan
from ..ocr.textutil import normalize
from ..scale.detect import ScaleResult, detect_scale
from ..titleblock.classify import DISCIPLINES, FLOORS, TitleBlock, _best_keyword, classify_sheet, read_title_block

GREEN_MIN = 0.85
RED_BELOW = 0.5

R_RASTER = "רסטר"
R_SCALE_CONFLICT = "קנה מידה סותר"
R_NO_SCALE = "קנה מידה לא נקרא"
R_SCALE_UNVERIFIED = "קנה מידה לא אומת מול מידות"
R_NO_TITLEBLOCK = "טבלת כותרת לא זוהתה"
R_NO_DISCIPLINE = "תחום לא זוהה"
R_MULTI_DISCIPLINE = "יותר מתחום אחד בכותרת"
R_NO_FLOOR = "קומה לא זוהתה"
R_LOW_OCR = "ביטחון קריאה נמוך"
R_DXF_UNITS = "יחידות DXF לא מוגדרות"
R_LOW_RES = "רזולוציה נמוכה"
R_DPI_UNKNOWN = "רזולוציה לא ידועה (הנחה 300DPI)"
R_LOW_CONFIDENCE = "ביטחון סיווג נמוך"

_SCALE_RE = re.compile(r"1\s*:\s*(\d{1,4})")


@dataclass
class Classification:
    discipline: str | None
    disciplines: list[str]
    floors: list[str]
    sheet_title: str
    scale_text: str
    scale_den: int | None
    confidence: float
    level: str
    reasons: list[str] = field(default_factory=list)
    title_block_bbox: tuple[float, float, float, float] | None = None
    scale: dict[str, Any] = field(default_factory=dict)
    source: str = "titleblock"

    def to_doc(self) -> dict[str, Any]:
        """The ``classification`` map of the sheet doc (no project name/address: PII)."""
        return {
            "discipline": self.discipline,
            "floors": list(self.floors),
            "sheetTitle": self.sheet_title,
            "scaleText": self.scale_text,
            "confidence": round(float(self.confidence), 3),
            "level": self.level,
            "reasons": list(self.reasons),
        }


@dataclass
class Issues:
    yellow: list[str] = field(default_factory=list)
    red: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)


def level_of(conf: float, issues: Issues, cap: str | None = None) -> str:
    order = {"green": 0, "yellow": 1, "red": 2}
    lv = "green" if conf >= GREEN_MIN else ("yellow" if conf >= RED_BELOW else "red")
    if issues.yellow and order[lv] < 1:
        lv = "yellow"
    if issues.red:
        lv = "red"
    if cap is not None and order[lv] < order[cap]:
        lv = cap
    return lv


def _floors_in_order(text: str) -> list[str]:
    found = [c for c, _ in _best_keyword(text, FLOORS, 0.75)]
    t = normalize(text)
    if "קומה" not in t and "קומת" not in t:
        found = [f for f in found if f not in ("first", "second", "third")]

    def pos(code: str) -> int:
        idx = [t.find(kw) for kw in FLOORS[code][1] if t.find(kw) >= 0]
        return min(idx) if idx else 10**6

    return sorted(found, key=pos)


def _from_free_text(spans: list[TextSpan]) -> tuple[str, str]:
    """(sheet title, scale text) from the biggest discipline-bearing text when there is no title block."""
    best: tuple[float, str] | None = None
    for s in spans:
        if len(s.text) > 80 or not s.text.strip():
            continue
        if _best_keyword(s.text, DISCIPLINES, 0.8):
            score = s.height * (1.5 if ("תכנית" in s.text or "ת." in s.text) else 1.0)
            if best is None or score > best[0]:
                best = (score, s.text)
    scales = [m.group(0) for s in spans for m in _SCALE_RE.finditer(s.text)]
    scale_text = max(set(scales), key=scales.count) if scales else ""
    return (best[1] if best else ""), scale_text


def classify_page(
    spans: list[TextSpan],
    vs: VectorSheet,
    *,
    raster: bool = False,
    known_scale: int | None = None,
    extra_yellow: list[str] | None = None,
    extra_red: list[str] | None = None,
    check_dimensions: bool = True,
) -> Classification:
    issues = Issues(yellow=list(extra_yellow or []), red=list(extra_red or []))
    tb = read_title_block(spans, vs)
    source = "titleblock"
    if tb.bbox is None or not tb.fields.get("sheet_name"):
        title, scale_txt = _from_free_text(spans)
        tb = TitleBlock(
            bbox=tb.bbox, fields={"sheet_name": title, "scale": scale_txt}, field_conf={"sheet_name": 0.6}, label_hits={}
        )
        source = "text"
        issues.yellow.append(R_NO_TITLEBLOCK)
    cls = classify_sheet(tb)
    title = cls.title
    floors = _floors_in_order(tb.fields.get("sheet_name", ""))
    conf = cls.confidence if source == "titleblock" else round(0.75 * cls.confidence, 3)
    if not cls.disciplines:
        issues.red.append(R_NO_DISCIPLINE)
    elif len(cls.disciplines) > 1:
        issues.yellow.append(R_MULTI_DISCIPLINE)
    if not floors:
        issues.yellow.append(R_NO_FLOOR)
    ocr_conf = tb.field_conf.get("sheet_name", 1.0)
    if source == "titleblock" and ocr_conf < 0.6:
        issues.yellow.append(R_LOW_OCR)

    scale_text = " ".join(tb.fields.get("scale", "").split())
    declared = cls.scale_den
    if declared is None and known_scale is not None:
        declared = known_scale
    if declared is None:
        others = [int(m.group(1)) for s in spans for m in _SCALE_RE.finditer(s.text) if int(m.group(1)) > 0]
        if others:
            declared = max(set(others), key=others.count)
            scale_text = scale_text or f"1:{declared}"
    sc: ScaleResult | None = None
    if declared is None:
        issues.yellow.append(R_NO_SCALE)
        conf *= 0.8
    elif check_dimensions:
        sc = detect_scale(declared, spans, vs)
        agree = round(sc.agree_share * sc.n_dimension_pairs)
        if sc.conflict or (sc.n_dimension_pairs >= 3 and agree == 0 and sc.from_dimensions is not None):
            issues.yellow.append(R_SCALE_CONFLICT)
            conf *= 0.7
        elif agree >= 1:
            issues.info.append(f"קנה מידה אומת מול {agree} מידות")
        else:
            issues.info.append(R_SCALE_UNVERIFIED)
            conf *= 0.95
    if raster:
        issues.yellow.append(R_RASTER)
    conf = max(0.0, min(1.0, conf))
    level = level_of(conf, issues, cap="yellow" if raster else None)
    if level != "green" and not issues.yellow and not issues.red:
        issues.yellow.append(R_LOW_CONFIDENCE)  # a non-green level is never left unexplained
    reasons = list(dict.fromkeys(issues.red + issues.yellow + issues.info))
    return Classification(
        discipline=cls.disciplines[0] if cls.disciplines else None,
        disciplines=list(cls.disciplines),
        floors=floors,
        sheet_title=title,
        scale_text=scale_text,
        scale_den=declared,
        confidence=round(conf, 3),
        level=level,
        reasons=reasons,
        title_block_bbox=tb.bbox,
        scale=asdict(sc) if sc is not None else {},
        source=source,
    )


def span_from_line(line: dict[str, Any], sheet: str = "") -> TextSpan:
    """text.json line (DXF / PDF text layer / raster OCR) -> TextSpan for the classifiers."""
    x0, y0, x1, y1 = (float(v) for v in line["bboxMm"])
    ang = float(line.get("angle", 0.0)) % 360.0
    rot = 0
    if 45 <= ang < 135:
        rot = 90
    elif 225 <= ang < 315:
        rot = -90
    h = float(line.get("heightMm") or ((y1 - y0) if rot == 0 else (x1 - x0)))
    return TextSpan(
        sheet=sheet,
        bbox=(x0, y0, x1, y1),
        text=str(line["text"]),
        conf=float(line.get("confidence", 1.0)),
        height=h,
        rotation=rot,
        n_glyphs=len(str(line["text"])),
    )


def span_to_line(s: TextSpan) -> dict[str, Any]:
    return {
        "text": s.text,
        "bboxMm": [round(float(v), 3) for v in s.bbox],
        "angle": {0: 0.0, 90: 90.0, -90: 270.0}.get(int(s.rotation), 0.0),
        "confidence": round(float(s.conf), 3),
        "heightMm": round(float(s.height), 3),
    }
