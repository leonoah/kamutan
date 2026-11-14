"""Per-fixture attributes of a lighting sheet, read from the drawing (Sprint 12, Worker-Accuracy).

The designer's install line ("התקנת גוף תאורה פשוט") prices the plain fixtures. Two kinds of drawn fixture are priced
elsewhere and must not be in it:

* ``garden`` — outdoor lighting. Evidence on the drawing: the fixture lies on a **timer circuit** (the boxed note
  "תאורות שנדלקות ע"י שעון שבת: D6 D3" — priced by the "הזנות … לתאורות דוקרנים … מפסק טיימר" line) of which at least half
  the fixtures stand outside every room; the sheet's own banner sends the development lighting to the landscape architect
  ("בפיתוח יש לעיין בתכנית פיתוח של אדריכל נוף") and the fixture is outside every room. The ``luminaire_outdoor`` class on its own is NOT a garden mark: Noah draws outdoor
  fixtures and the designer prices them on the install line (leave-one-project-out, Sprint 12).
* ``profile_feed`` — the point that feeds an LED profile / strip (priced on the profile lines): a pale-yellow thin filled
  bar (the profile, ≥ 12 mm long, ≤ 1.2 mm wide) starts at it. Each bar takes the nearest fixture within
  :data:`FEED_REACH_MM` of one of its ends, one bar per feed.

``fixture_attributes`` returns ``{detection id: attribute}``; the ``understand`` stage stores it in ``circuits.json.gz``
(``fixtureAttributes``) and the BOQ aggregation skips these detections in the class → item count.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from typing import Any

import numpy as np

from ..ingest.pdf_vector import VectorSheet

FIXTURE_CLASSES = frozenset({"luminaire_ceiling", "luminaire_wall", "luminaire_pendant", "luminaire_outdoor", "ceiling_fan"})
GARDEN = "garden"
PROFILE_FEED = "profile_feed"
FEED_REACH_MM = 25.0
BAR_MIN_LEN_MM = 12.0
BAR_MAX_WIDTH_MM = 1.2
BAR_ASPECT = 12.0
TIMER_OUTSIDE_SHARE = 0.5
LANDSCAPE_BANNER = re.compile(r"אדריכל\s*נוף|אדריכלית\s*נוף|תכנית\s*פיתוח")


def profile_bars(vs: VectorSheet) -> list[tuple[float, float, float, float]]:
    """End points ``(x0, y0, x1, y1)`` of the LED-profile bars: thin, long, pale-yellow filled rectangles."""
    if vs.n_paths == 0:
        return []
    bb = vs.path_bbox.astype(np.float64)
    w, h = bb[:, 2] - bb[:, 0], bb[:, 3] - bb[:, 1]
    long_, short = np.maximum(w, h), np.minimum(w, h)
    rgb = vs.path_fill_rgba[:, :3].astype(np.int32)
    yellow = (rgb[:, 0] >= 200) & (rgb[:, 1] >= 200) & (rgb[:, 2] <= 0.6 * rgb[:, 0])
    ok = np.where(
        (vs.path_fill_mode > 0) & yellow & (long_ >= BAR_MIN_LEN_MM) & (short <= BAR_MAX_WIDTH_MM)
        & (long_ >= BAR_ASPECT * np.maximum(short, 0.05))
    )[0]  # fmt: skip
    out: list[tuple[float, float, float, float]] = []
    for k in ok:
        x0, y0, x1, y1 = (float(v) for v in bb[k])
        if w[k] < h[k]:
            out.append(((x0 + x1) / 2, y0, (x0 + x1) / 2, y1))
        else:
            out.append((x0, (y0 + y1) / 2, x1, (y0 + y1) / 2))
    return out


def fixture_attributes(
    vs: VectorSheet | None,
    spans: Sequence[Any],
    detections: Sequence[dict[str, Any]],
    circuits: dict[str, Any] | None,
) -> dict[str, str]:
    fixtures = [d for d in detections if d.get("class") in FIXTURE_CLASSES]
    out: dict[str, str] = {}
    for c in (circuits or {}).get("circuits", []):
        if not c.get("timer"):
            continue
        ids = set(c.get("fixtureIds") or [])
        fx = [d for d in fixtures if d["id"] in ids]
        if fx and sum(1 for d in fx if not d.get("roomId")) >= TIMER_OUTSIDE_SHARE * len(fx):
            out.update({d["id"]: GARDEN for d in fx})
    banner = any(LANDSCAPE_BANNER.search(getattr(s, "text", "") or "") for s in spans)
    for d in fixtures:
        # the class alone is no evidence (Noah draws outdoor fixtures and prices them on the install line)
        if banner and not d.get("roomId"):
            out[d["id"]] = GARDEN
    if vs is not None:
        cand: list[tuple[float, int, str]] = []
        for i, (x0, y0, x1, y1) in enumerate(profile_bars(vs)):
            for d in fixtures:
                if d["id"] in out:
                    continue
                x, y = d["centerMm"]["x"], d["centerMm"]["y"]
                dist = min(math.hypot(x - x0, y - y0), math.hypot(x - x1, y - y1))
                if dist <= FEED_REACH_MM:
                    cand.append((dist, i, d["id"]))
        used: set[int] = set()
        for _, i, did in sorted(cand):
            if i not in used and did not in out:
                used.add(i)
                out[did] = PROFILE_FEED
    return out


R_BOX_NO_GLYPH = "מיקום מפסק ללא סמל מפסק"


def glyphless_switch_boxes(sheet: Any) -> list[Any]:
    """Detections (class ``switch_single``) standing for the switch boxes of one lighting sheet that the circuits read
    from their tag lists but where no switch glyph was detected (``positions`` without ``switchIds``). A sheet that
    compiles several floors is skipped — its boxes are the floor sheets' own."""
    from ..boq.dedup import Det

    circ = sheet.circuits if isinstance(sheet.circuits, dict) else {}
    floors = list(getattr(sheet, "floors", None) or [])
    if len(floors) > 1:
        return []
    out: list[Any] = []
    for pos in circ.get("positions") or []:
        if pos.get("switchIds"):
            continue
        b = pos.get("boxMm") or pos.get("bboxMm") or {}
        out.append(
            Det(
                sheet.sheet_id,
                sheet.version_id,
                f"box:{pos.get('id')}",
                "switch_single",
                float(b.get("x", 0.0)) + float(b.get("w", 0.0)) / 2,
                float(b.get("y", 0.0)) + float(b.get("h", 0.0)) / 2,
                "yellow",
                [R_BOX_NO_GLYPH],
                floors[0] if floors else None,
                "new",
                None,
                sheet.discipline,
            )
        )
    return out
