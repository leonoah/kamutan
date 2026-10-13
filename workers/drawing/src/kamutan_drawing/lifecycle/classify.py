"""Existing / new / demolish per bbox (Sprint 2, Worker-B).

Evidence, strongest first:

1. **Text next to the item** (``legend_hints["text"]``): "להריסה" / "הריסת" / "פירוק" → demolish
   (also "פירוק מטבח קיים": demolishing wins over "קיים"); "קיים" / "נק' קיימת" → existing;
   "חדש" / "מתוכנן" → new. Each lifecycle text votes only for its *nearest* bbox (leader-line
   notes sit a few mm away from the symbol they describe).
2. **Stroke / fill colour of the item** mapped by the legend (``legend_hints["colors"]``,
   ``{"#ffff14": "demolish"}``), else by the sheet kind: on a demolition plan the highlighted
   (non-grey) colour means demolish, on a construction plan it means new (sample set: yellow
   on ת. הריסה, red on ת. בניה — measured, see NOTES.md).
3. **Line style**: dashed strokes → ``legend_hints["dashed"]`` when the legend says what dashed means.
4. ``legend_hints["default"]`` (e.g. "new" on an MEP sheet whose legend says so), low confidence.

Otherwise ``unknown`` with a reason. Confidence never reaches green from colour priors alone.

``legend_hints`` keys (all optional): ``text`` (list of items with ``bbox`` x0,y0,x1,y1 + ``text``, e.g. the
page ``TextSpan`` list), ``colors`` ({"#rrggbb" | (r,g,b): lifecycle}), ``dashed`` (lifecycle),
``default`` (lifecycle), ``discipline`` (sheet discipline, e.g. "demolition" / "construction"),
``exclude_paths`` (path indices to ignore, e.g. SHX text strokes; defaults to ``prims.stats['textPaths']``).
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Any, cast

import numpy as np

from ..ingest.pdf_vector import VectorSheet
from ..types_sprint2 import BBox, Lifecycle, LifecycleResult

LIFECYCLES: tuple[str, ...] = ("existing", "new", "demolish", "unknown")

RE_DEMOLISH = re.compile(r"להריס|הריס|לפירוק|פירוק|לביטול|מבוטל|לפרק|יפורק|תפורק")
RE_EXISTING = re.compile(r"קיימ|קיים")
RE_NEW = re.compile(r"חדש|מתוכנ|מוצע|יבוצע")

TEXT_REACH_MM = 12.0
COLOR_TOL = 60.0  # RGB euclidean
GREY_SPREAD = 24  # max channel spread of a neutral (black / grey) colour
PAD_MM = 0.3

R_TEXT = {"existing": "כיתוב 'קיים' ליד הפריט", "new": "כיתוב 'חדש' ליד הפריט", "demolish": "כיתוב 'הריסה/פירוק' ליד הפריט"}
R_COLOR_LEGEND = "לפי צבע במקרא"
R_COLOR_SHEET = "לפי צבע (סוג הגיליון)"
R_DASHED = "קו מקווקו לפי המקרא"
R_DEFAULT = "ברירת מחדל של הגיליון"
R_CONFLICT = "סתירה בין צבע לכיתוב"
R_UNKNOWN = "לא נקבע מצב קיים/חדש/הריסה"

DEMOLITION_DISCIPLINES = {"demolition"}
NEW_DISCIPLINES = {"construction"}


def _rgb(v: Any) -> tuple[int, int, int]:
    if isinstance(v, str):
        h = v.lstrip("#")
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    t = list(v)
    return (int(t[0]), int(t[1]), int(t[2]))


def _neutral(c: Sequence[int]) -> bool:
    return max(c) - min(c) <= GREY_SPREAD


def _text_lifecycle(text: str) -> str | None:
    if RE_DEMOLISH.search(text):
        return "demolish"
    if RE_NEW.search(text):
        return "new"
    if RE_EXISTING.search(text):
        return "existing"
    return None


def _xyxy(t: Any) -> tuple[float, float, float, float] | None:
    b = getattr(t, "bbox", None)
    if b is None and isinstance(t, Mapping):
        b = t.get("bboxMm") or t.get("bbox")
    if b is None:
        return None
    if isinstance(b, Mapping):
        bb = BBox.from_json(b)
        return bb.as_xyxy()
    v = [float(x) for x in list(b)[:4]]
    return (min(v[0], v[2]), min(v[1], v[3]), max(v[0], v[2]), max(v[1], v[3]))


def _text_of(t: Any) -> str:
    s = getattr(t, "text", None)
    if s is None and isinstance(t, Mapping):
        s = t.get("text")
    return str(s or "")


def _box_dist(b: BBox, x: float, y: float) -> float:
    dx = max(b.x - x, 0.0, x - b.x1)
    dy = max(b.y - y, 0.0, y - b.y1)
    return float(np.hypot(dx, dy))


def _text_votes(boxes: list[BBox], texts: Sequence[Any]) -> dict[int, list[tuple[str, float]]]:
    votes: dict[int, list[tuple[str, float]]] = defaultdict(list)
    if not boxes:
        return votes
    for t in texts:
        lc = _text_lifecycle(_text_of(t))
        if lc is None:
            continue
        tb = _xyxy(t)
        if tb is None:
            continue
        # nearest bbox to the text box (closest point of the text box)
        cands: list[tuple[float, int]] = []
        for k, b in enumerate(boxes):
            dx = max(b.x - tb[2], 0.0, tb[0] - b.x1)
            dy = max(b.y - tb[3], 0.0, tb[1] - b.y1)
            cands.append((float(np.hypot(dx, dy)), k))
        cands.sort()
        d, k = cands[0]
        if d > TEXT_REACH_MM:
            continue
        # a second item just as close: the note is ambiguous, weaker vote for both
        ambiguous = len(cands) > 1 and cands[1][0] - d < 1.0
        w = (0.8 - 0.25 * d / TEXT_REACH_MM) * (0.75 if ambiguous else 1.0)
        votes[k].append((lc, w))
        if ambiguous:
            votes[cands[1][1]].append((lc, w))
    return votes


def _colour_stats(vs: VectorSheet, b: BBox, exclude: np.ndarray) -> tuple[dict[tuple[int, int, int], float], float]:
    """Ink length per colour of segments inside ``b`` (fills count by their outline) and the dashed share."""
    s = vs.segs
    mx, my = (s[:, 0] + s[:, 2]) / 2, (s[:, 1] + s[:, 3]) / 2
    m = (mx >= b.x - PAD_MM) & (mx <= b.x1 + PAD_MM) & (my >= b.y - PAD_MM) & (my <= b.y1 + PAD_MM)
    m &= ~exclude[vs.seg_path]
    idx = np.where(m)[0]
    out: dict[tuple[int, int, int], float] = defaultdict(float)
    if len(idx) == 0:
        return out, 0.0
    ln = np.hypot(s[idx, 2] - s[idx, 0], s[idx, 3] - s[idx, 1])
    paths = vs.seg_path[idx]
    dashed_len = 0.0
    total = 0.0
    for p, L in zip(paths.tolist(), ln.tolist(), strict=True):
        if vs.path_fill_mode[p] > 0 and vs.path_fill_rgba[p, 3] > 0:
            c = tuple(int(v) for v in vs.path_fill_rgba[p, :3])
        else:
            c = tuple(int(v) for v in vs.path_stroke_rgba[p, :3])
        if min(c) >= 245:
            continue
        out[cast(tuple[int, int, int], c)] += L
        total += L
        if vs.path_dash[p]:
            dashed_len += L
    return out, (dashed_len / total if total > 0 else 0.0)


def _match_colour(c: tuple[int, int, int], table: Mapping[tuple[int, int, int], str]) -> str | None:
    best: tuple[float, str] | None = None
    for k, v in table.items():
        d = float(np.sqrt(sum((a - b) ** 2 for a, b in zip(c, k, strict=True))))
        if d <= COLOR_TOL and (best is None or d < best[0]):
            best = (d, v)
    return best[1] if best else None


def classify(
    prims: VectorSheet, bboxes_mm: Sequence[BBox | Sequence[float] | Mapping[str, Any]], legend_hints: Mapping[str, Any] | None
) -> list[LifecycleResult]:
    """One :class:`LifecycleResult` per bbox (brief signature). See the module docstring for ``legend_hints``."""
    hints = dict(legend_hints or {})
    boxes = [BBox.coerce(b) for b in bboxes_mm]
    colour_table: dict[tuple[int, int, int], str] = {}
    for k, v in (hints.get("colors") or {}).items():
        if v in LIFECYCLES and v != "unknown":
            colour_table[_rgb(k)] = str(v)
    discipline = str(hints.get("discipline") or "")
    sheet_colour = "demolish" if discipline in DEMOLITION_DISCIPLINES else ("new" if discipline in NEW_DISCIPLINES else None)
    dashed = hints.get("dashed") if hints.get("dashed") in ("existing", "new", "demolish") else None
    default = hints.get("default") if hints.get("default") in ("existing", "new", "demolish") else None
    ex_list = hints.get("exclude_paths")
    if ex_list is None:
        ex_list = prims.stats.get("textPaths", []) or []
    exclude = np.zeros(prims.n_paths, bool)
    if len(ex_list):
        ii = np.asarray([i for i in ex_list if 0 <= int(i) < prims.n_paths], dtype=np.int64)
        exclude[ii] = True
    votes = _text_votes(boxes, hints.get("text") or [])

    out: list[LifecycleResult] = []
    for k, b in enumerate(boxes):
        score: dict[str, float] = defaultdict(float)
        why: dict[str, list[str]] = defaultdict(list)
        for lc, w in votes.get(k, []):
            score[lc] = max(score[lc], w)
            if R_TEXT[lc] not in why[lc]:
                why[lc].append(R_TEXT[lc])
        text_lc = max(score, key=lambda x: score[x]) if score else None

        cols, dashed_share = _colour_stats(prims, b, exclude)
        colour_lc: str | None = None
        colour_conf = 0.0
        if cols:
            total = sum(cols.values())
            # strongest non-neutral colour with a meaning
            for c, L in sorted(cols.items(), key=lambda kv: -kv[1]):
                share = L / total
                if share < 0.25:
                    break
                mapped = _match_colour(c, colour_table) if colour_table else None
                if mapped is not None:
                    colour_lc, colour_conf = mapped, 0.6 + 0.3 * share
                    why[mapped].append(R_COLOR_LEGEND)
                    break
                if sheet_colour is not None:
                    if not _neutral(c):
                        colour_lc, colour_conf = sheet_colour, 0.45 + 0.2 * share
                        why[sheet_colour].append(R_COLOR_SHEET)
                    elif share >= 0.6:
                        # plain black / grey on a demolition or construction plan = existing, kept
                        colour_lc, colour_conf = "existing", 0.4 + 0.15 * share
                        why["existing"].append(R_COLOR_SHEET)
                    break
        if colour_lc is not None:
            score[colour_lc] = max(score[colour_lc], colour_conf)
        if dashed is not None and dashed_share >= 0.5:
            score[dashed] = max(score[dashed], 0.55 + 0.2 * dashed_share)
            why[dashed].append(R_DASHED)

        if not score:
            if default is not None:
                out.append(LifecycleResult(cast(Lifecycle, default), 0.5, [R_DEFAULT]))
            else:
                out.append(LifecycleResult("unknown", 0.0, [R_UNKNOWN]))
            continue
        ranked = sorted(score.items(), key=lambda kv: -kv[1])
        lc, conf = ranked[0]
        reasons = list(why[lc])
        if text_lc is not None and colour_lc is not None and text_lc != colour_lc:
            conf = min(conf, 0.45)
            reasons.append(R_CONFLICT)
        elif len(ranked) > 1 and ranked[1][1] >= ranked[0][1] - 0.1:
            conf = min(conf, 0.5)
            reasons.append(R_CONFLICT)
        else:
            # agreeing independent evidence
            if text_lc == lc and colour_lc == lc:
                conf = min(0.92, conf + 0.15)
        out.append(LifecycleResult(cast(Lifecycle, lc), round(float(conf), 3), reasons))
    return out
