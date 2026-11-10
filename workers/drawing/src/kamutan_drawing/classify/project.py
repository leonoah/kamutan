"""Project-level sheet reconciliation (Sprint 10, Worker-Classify): what one sheet cannot know alone.

Two rules over all current sheets of a project, from the text each sheet carries (``text.json.gz``: SHX + PDF text
layer) — the base plan's room names, dimensions and circuit tags sit at the same relative positions on every sheet
drawn on that floor plan:

* **Duplicate coverage** — Achituv's "תאורה - כל הקומות" holds the three per-floor lighting plans again, so every
  luminaire was counted twice (162 vs 62). A sheet S is an *overview* when at least two other current sheets of S's
  discipline, each of one distinct floor, are contained in it (≥ ``CONTAIN_MIN`` of their text found in S at one
  consistent offset, different offsets per sheet). S is never dropped silently: it is marked ``coverage.status =
  "overview"`` with the covering sheets and a Hebrew reason; the BOQ build skips it (``skippedSheets: overview``), the
  per-floor sheets are counted. S's floors become the union of the floors it repeats.
* **Floor collisions** — Achituv's title blocks of four first-floor sheets say "קומת קרקע"/"קומת מרתף" (copy-paste in
  the designer's template). Two sheets of one discipline claiming the same single floor while the discipline has no
  sheet for another floor of the project is a contradiction; it is resolved by *support* — the best text overlap with
  sheets of other disciplines whose floor is not in dispute — over the injective assignments of the disputed sheets to
  {claimed floor} ∪ {missing floors}, accepted with a margin; the moved sheet gets a reason naming the title's floor.

Confirmed sheets are never changed (their floors still support others). Pure: the orchestrator passes plain facts.
"""

from __future__ import annotations

import itertools
import logging
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..ocr.textutil import normalize

log = logging.getLogger(__name__)

TOL_MM = 1.0  # offset vote bin
MATCH_MM = 1.6  # a token matches at the voted offset within this distance
MAX_TOKENS = 3000
MAX_SAME_TEXT = 25  # tokens with more copies than this on one sheet ("פ", "3") do not vote
CONTAIN_MIN = 0.7  # share of a per-floor sheet's tokens found in the overview
MIN_TOKENS = 12  # a sheet with fewer usable tokens neither covers nor is covered
SUPPORT_MIN = 0.15  # a floor needs at least this overlap with a sheet of that floor
SUPPORT_MARGIN = 0.15  # the chosen assignment must beat the next one by this much (sum of supports)

R_OVERVIEW = "גיליון מרוכז: התוכן מופיע בגיליונות {sheets} — לא נספר בכתב הכמויות"
R_FLOOR_FROM_PROJECT = "קומה לפי השוואה לגיליונות אחרים בפרויקט (בכותרת: {title})"
R_FLOOR_CLASH = "שני גיליונות של אותו תחום מסומנים לאותה קומה ({floor})"
R_DUPLICATE = "ייתכן שזה אותו גיליון פעמיים (גרסה אחרת של {other}) — בדוק איזה מהם לספור"
DUPLICATE_MIN = 0.5  # mutual containment of two sheets of one discipline and floor: two versions of one sheet

FLOOR_HE = {"basement": "מרתף", "ground": "קרקע", "first": "קומה א'", "second": "קומה ב'", "third": "קומה ג'", "roof": "גג"}

Token = tuple[str, float, float]


@dataclass
class SheetFacts:
    sheet_id: str
    discipline: str | None
    floors: list[str]
    tokens: list[Token]
    confirmed: bool = False
    title: str = ""


@dataclass
class Coverage:
    covered_by: list[str]
    floors: list[str]
    share: float
    reason: str

    def to_doc(self) -> dict[str, Any]:
        return {
            "status": "overview",
            "coveredBy": list(self.covered_by)[:16],
            "floors": list(self.floors)[:16],
            "contentShare": round(float(self.share), 3),
            "reason": self.reason[:300],
        }


@dataclass
class FloorFix:
    floors: list[str]
    title_floors: list[str]
    support: float
    reason: str


@dataclass
class Reconciled:
    overviews: dict[str, Coverage] = field(default_factory=dict)
    floor_fixes: dict[str, FloorFix] = field(default_factory=dict)
    clashes: dict[str, str] = field(default_factory=dict)  # sheet id -> reason (unresolved)


def tokens_from_lines(
    lines: Iterable[Mapping[str, Any]], exclude: tuple[float, float, float, float] | None = None
) -> list[Token]:
    """Text print of a sheet: (normalised text, centre x, centre y) of every PDF text-layer line (``src: "pdf"``) with
    ≥ 2 letters / digits, outside ``exclude`` (the title block: the same on every sheet of the project).

    Only font text is used: it is exact and identical on every sheet that shows it, while SHX readings vary from sheet
    to sheet with the glyph store (an SHX-only project such as Noah has no print, and nothing here changes it)."""
    out: list[Token] = []
    for ln in lines:
        if ln.get("src") != "pdf":
            continue
        try:
            t = normalize(str(ln.get("text", "")))
            x0, y0, x1, y1 = (float(v) for v in ln["bboxMm"])
        except (KeyError, TypeError, ValueError):
            continue
        if sum(ch.isalnum() for ch in t) < 2:
            continue
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if exclude is not None and exclude[0] - 1 <= cx <= exclude[2] + 1 and exclude[1] - 1 <= cy <= exclude[3] + 1:
            continue
        out.append((t, cx, cy))
        if len(out) >= MAX_TOKENS:
            break
    return out


def _index(tokens: Sequence[Token]) -> dict[str, list[tuple[float, float]]]:
    idx: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for t, x, y in tokens:
        idx[t].append((x, y))
    return idx


def overlap(a: Sequence[Token], b: Sequence[Token]) -> tuple[int, tuple[float, float]]:
    """Tokens of ``b`` found in ``a`` at the single best offset (b + offset = a), and that offset (mm)."""
    ia = _index(a)
    votes: Counter[tuple[int, int]] = Counter()
    for t, x, y in b:
        pts = ia.get(t)
        if not pts or len(pts) > MAX_SAME_TEXT:
            continue
        for xa, ya in pts:
            votes[(round((xa - x) / TOL_MM), round((ya - y) / TOL_MM))] += 1
    if not votes:
        return 0, (0.0, 0.0)
    (bx, by), _ = votes.most_common(1)[0]
    dx, dy = bx * TOL_MM, by * TOL_MM
    m = 0
    for t, x, y in b:
        pts = ia.get(t)
        if pts and any(abs(xa - x - dx) <= MATCH_MM and abs(ya - y - dy) <= MATCH_MM for xa, ya in pts):
            m += 1
    return m, (dx, dy)


def contained(inner: Sequence[Token], outer: Sequence[Token]) -> tuple[float, tuple[float, float]]:
    """Share of ``inner``'s tokens found in ``outer`` at one offset."""
    if len(inner) < MIN_TOKENS:
        return 0.0, (0.0, 0.0)
    m, off = overlap(outer, inner)
    return m / len(inner), off


def similarity(a: Sequence[Token], b: Sequence[Token]) -> float:
    if min(len(a), len(b)) < MIN_TOKENS:
        return 0.0
    m, _ = overlap(a, b)
    return m / min(len(a), len(b))


def _floor_names(floors: Iterable[str]) -> str:
    return ", ".join(FLOOR_HE.get(f, f) for f in floors)


def find_overviews(sheets: Sequence[SheetFacts]) -> dict[str, Coverage]:
    out: dict[str, Coverage] = {}
    by_disc: dict[str, list[SheetFacts]] = defaultdict(list)
    for s in sheets:
        if s.discipline:
            by_disc[s.discipline].append(s)
    for group in by_disc.values():
        singles = [t for t in group if len(t.floors) == 1]
        for s in group:
            if len(s.tokens) < MIN_TOKENS:
                continue
            parts: dict[str, tuple[float, SheetFacts, tuple[float, float]]] = {}
            for t in singles:
                if t is s or len(t.tokens) * 1.2 > len(s.tokens):  # the overview holds more than each part
                    continue
                share, off = contained(t.tokens, s.tokens)
                if share < CONTAIN_MIN:
                    continue
                f = t.floors[0]
                if f not in parts or share > parts[f][0]:
                    parts[f] = (share, t, off)
            offsets = {(round(o[0] / 5.0), round(o[1] / 5.0)) for _, _, o in parts.values()}
            if len(parts) < 2 or len(offsets) < len(parts):  # distinct floors drawn at distinct places
                continue
            names = [p[1].title or p[1].sheet_id for p in parts.values()]
            out[s.sheet_id] = Coverage(
                covered_by=[p[1].sheet_id for p in parts.values()],
                floors=list(parts),
                share=min(p[0] for p in parts.values()),
                reason=R_OVERVIEW.format(sheets=", ".join(names)),
            )
    return out


def resolve_floor_clashes(
    sheets: Sequence[SheetFacts], overviews: Mapping[str, Coverage]
) -> tuple[dict[str, FloorFix], dict[str, str]]:
    current = [s for s in sheets if s.sheet_id not in overviews and s.discipline]
    project_floors = sorted({f for s in current for f in s.floors if f and f != "unknown"})
    disputed: set[str] = set()
    groups: list[tuple[str, str, list[SheetFacts]]] = []
    by_disc: dict[str, list[SheetFacts]] = defaultdict(list)
    for s in current:
        by_disc[str(s.discipline)].append(s)
    for disc, group in by_disc.items():
        claims: dict[str, list[SheetFacts]] = defaultdict(list)
        for s in group:
            if len(s.floors) == 1:
                claims[s.floors[0]].append(s)
        for floor, members in claims.items():
            if len(members) > 1:
                groups.append((disc, floor, members))
                disputed.update(m.sheet_id for m in members)
    fixes: dict[str, FloorFix] = {}
    clashes: dict[str, str] = {}
    referees = [s for s in current if len(s.floors) == 1 and s.sheet_id not in disputed]
    for disc, floor, members in groups:
        have = {f for s in by_disc[disc] for f in s.floors}
        missing = [f for f in project_floors if f not in have]
        cands = [floor, *missing]
        movable = [m for m in members if not m.confirmed]

        def support(s: SheetFacts, f: str, disc: str = disc) -> float:
            vals = [similarity(s.tokens, r.tokens) for r in referees if r.floors[0] == f and r.discipline != disc]
            return max(vals, default=0.0)

        sup = {(m.sheet_id, f): support(m, f) for m in members for f in cands}
        best: list[tuple[float, tuple[str, ...]]] = []
        for perm in itertools.permutations(cands, len(members)):
            if any(m.confirmed and p != floor for m, p in zip(members, perm, strict=True)):
                continue
            if any(sup[(m.sheet_id, p)] < SUPPORT_MIN and p != floor for m, p in zip(members, perm, strict=True)):
                continue
            best.append((sum(sup[(m.sheet_id, p)] for m, p in zip(members, perm, strict=True)), perm))
        best.sort(key=lambda kv: -kv[0])
        ok = (
            bool(missing)
            and bool(movable)
            and best
            and (len(best) == 1 or best[0][0] - best[1][0] >= SUPPORT_MARGIN)
            and any(p != floor for p in best[0][1])
        )
        if not ok:
            same = (
                len(members) == 2
                and min(contained(members[0].tokens, members[1].tokens)[0], contained(members[1].tokens, members[0].tokens)[0])
                >= DUPLICATE_MIN
            )
            for m in members:
                other = next(x for x in members if x is not m)
                clashes[m.sheet_id] = (
                    R_DUPLICATE.format(other=other.title or other.sheet_id)
                    if same
                    else R_FLOOR_CLASH.format(floor=_floor_names([floor]))
                )
            continue
        for m, p in zip(members, best[0][1], strict=True):
            if p != floor:
                fixes[m.sheet_id] = FloorFix(
                    floors=[p],
                    title_floors=list(m.floors),
                    support=round(sup[(m.sheet_id, p)], 3),
                    reason=R_FLOOR_FROM_PROJECT.format(title=_floor_names(m.floors)),
                )
    return fixes, clashes


def reconcile(sheets: Sequence[SheetFacts]) -> Reconciled:
    """Overviews, then floor clashes, then both again on the corrected floors (an overview's parts are keyed by
    floor: a part whose title floor was wrong hid another part of the same claimed floor)."""
    ov = find_overviews(sheets)
    fixes, clashes = resolve_floor_clashes(sheets, ov)
    if not fixes:
        return Reconciled(ov, fixes, clashes)
    fixed = [
        SheetFacts(
            s.sheet_id,
            s.discipline,
            fixes[s.sheet_id].floors if s.sheet_id in fixes else s.floors,
            s.tokens,
            s.confirmed,
            s.title,
        )
        for s in sheets
    ]
    ov = find_overviews(fixed)
    fixes2, clashes = resolve_floor_clashes(fixed, ov)
    fixes = {sid: f for sid, f in fixes.items() if sid not in ov}
    for sid, f in fixes2.items():  # a second-round move keeps the title's floors as its reference
        orig = next(s for s in sheets if s.sheet_id == sid)
        fixes[sid] = FloorFix(
            f.floors, list(orig.floors), f.support, R_FLOOR_FROM_PROJECT.format(title=_floor_names(orig.floors))
        )
    return Reconciled(ov, fixes, clashes)


# ---------------------------------------------------------------------------------------------------------------
# Orchestrator glue: read the project's current sheets, reconcile, write the marks (idempotent, best effort)

FLOOR_CHECK = "floorCheck"  # sheet doc: {titleFloors, floors, support, reason} while a project floor fix applies
COVERAGE = "coverage"  # sheet doc: Coverage.to_doc() while the sheet is an overview, else null
MAX_SHEETS = 300


def _title_bbox(vdoc: Mapping[str, Any]) -> tuple[float, float, float, float] | None:
    tb = vdoc.get("titleBlockMm")
    if isinstance(tb, Mapping):
        try:
            x, y, w, h = (float(tb[k]) for k in ("x", "y", "w", "h"))
            return (x, y, x + w, y + h)
        except (KeyError, TypeError, ValueError):
            return None
    return None


def _clean_reasons(reasons: Iterable[Any]) -> list[str]:
    prefixes = (
        R_OVERVIEW.split(":")[0],
        R_FLOOR_FROM_PROJECT.split("(")[0].strip(),
        R_FLOOR_CLASH.split("(")[0].strip(),
        R_DUPLICATE.split("(")[0].strip(),
    )
    return [str(r) for r in reasons if not str(r).startswith(prefixes)]


def apply_to_project(docs: Any, blobs: Any, org_id: str, project_id: str) -> Reconciled | None:
    """Reconcile the project's current sheets and write ``coverage`` / ``floorCheck`` / ``floors`` / region floors /
    reasons. Confirmed sheets keep their floors. Returns what was found (None: nothing to do)."""
    import gzip
    import json

    from ..pipeline.artifacts import version_prefix
    from ..pipeline.floor_check import flag_floor_contradiction

    proj = f"orgs/{org_id}/projects/{project_id}"
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return None
    facts: list[SheetFacts] = []
    meta: dict[str, tuple[dict[str, Any], dict[str, Any], str]] = {}
    for sid, s in list(lister(f"{proj}/sheets"))[:MAX_SHEETS]:
        if not isinstance(s, dict) or s.get("superseded") is True or not s.get("discipline"):
            continue
        vid = s.get("currentVersionId")
        if not isinstance(vid, str) or not vid:
            continue
        vdoc = docs.get(f"{proj}/sheets/{sid}/versions/{vid}") or {}
        if vdoc.get("status") != "ready":
            continue
        pre = version_prefix(org_id, project_id, sid, vid)
        tpath = str((vdoc.get("artifacts") or {}).get("text") or pre + "text.json.gz")
        lines: list[Any] = []
        if tpath.startswith(pre):
            try:
                lines = list(json.loads(gzip.decompress(blobs.read(tpath))).get("lines") or [])
            except Exception:  # a missing / unreadable text artifact: the sheet has no print
                log.warning("text artifact of %s unreadable", sid, exc_info=True)
                lines = []
        fc = s.get(FLOOR_CHECK) if isinstance(s.get(FLOOR_CHECK), dict) else None
        floors = [str(f) for f in ((fc or {}).get("titleFloors") if fc and not s.get("confirmed") else s.get("floors")) or []]
        cdoc = s.get("classification")
        cls: dict[str, Any] = cdoc if isinstance(cdoc, dict) else {}
        facts.append(
            SheetFacts(sid, str(s["discipline"]), floors, tokens_from_lines(lines, _title_bbox(vdoc)), bool(s.get("confirmed")),
                       str(s.get("title") or cls.get("sheetTitle") or sid)[:80])
        )  # fmt: skip
        meta[sid] = (s, vdoc, f"{proj}/sheets/{sid}/versions/{vid}")
    if len(facts) < 2:
        return None
    rec = reconcile(facts)
    for f in facts:
        s, vdoc, vpath = meta[f.sheet_id]
        cls = dict(s.get("classification") or {})
        reasons = _clean_reasons(cls.get("reasons") or [])
        upd: dict[str, Any] = {}
        ov = rec.overviews.get(f.sheet_id)
        fix = rec.floor_fixes.get(f.sheet_id)
        new_floors: list[str] | None = None
        if ov is not None:
            upd[COVERAGE] = ov.to_doc()
            reasons.append(ov.reason)
            if not f.confirmed and set(ov.floors) > set(f.floors):
                new_floors = [x for x in FLOOR_HE if x in ov.floors] + [x for x in ov.floors if x not in FLOOR_HE]
        elif s.get(COVERAGE):
            upd[COVERAGE] = None
        if fix is not None and not f.confirmed:
            new_floors = list(fix.floors)
            upd[FLOOR_CHECK] = {
                "titleFloors": fix.title_floors,
                "floors": fix.floors,
                "support": fix.support,
                "reason": fix.reason,
            }
            reasons.append(fix.reason)
        elif s.get(FLOOR_CHECK) and not f.confirmed:
            new_floors = [str(x) for x in (s[FLOOR_CHECK].get("titleFloors") or [])]  # the fix no longer applies
            upd[FLOOR_CHECK] = None
        if f.sheet_id in rec.clashes:
            reasons.append(rec.clashes[f.sheet_id])
        cls["reasons"] = reasons[:32]
        if new_floors is not None:
            cls = flag_floor_contradiction(cls, new_floors) if cls.get("floors") else cls
            upd["floors"] = new_floors[:16]
            regs = [r for r in (vdoc.get("regions") or []) if isinstance(r, dict)]
            if regs and len(new_floors) == 1:
                docs.set(vpath, {"regions": [{**r, "floor": new_floors[0]} for r in regs]})
        if (ov is not None or fix is not None or f.sheet_id in rec.clashes) and cls.get("level") == "green":
            cls["level"] = "yellow"
        if cls != (s.get("classification") or {}) or upd:
            upd["classification"] = cls
            docs.set(f"{proj}/sheets/{f.sheet_id}", upd)
    return rec


def remap_floors(
    sheet_doc: Mapping[str, Any], detections: list[dict[str, Any]], circuits: Any
) -> tuple[list[dict[str, Any]], Any]:
    """BOQ side of a floor fix: the detections (and lighting circuits) of a version carry the floor the understand stage
    gave them from the title; while ``floorCheck`` moves the sheet to another floor they are re-labelled in memory
    (single floor → single floor only; a confirmed sheet is the user's and is handled by the confirmation path)."""
    fc = sheet_doc.get(FLOOR_CHECK)
    if not isinstance(fc, Mapping) or sheet_doc.get("confirmed"):
        return detections, circuits
    old, new = list(fc.get("titleFloors") or []), list(fc.get("floors") or [])
    if len(old) != 1 or len(new) != 1 or old == new:
        return detections, circuits
    dets = [{**d, "floor": new[0]} if d.get("floor") == old[0] else d for d in detections]
    if isinstance(circuits, dict) and isinstance(circuits.get("circuits"), list):
        circuits = {
            **circuits,
            "circuits": [
                {**c, "floor": new[0]} if isinstance(c, dict) and c.get("floor") == old[0] else c for c in circuits["circuits"]
            ],
        }
    return dets, circuits
