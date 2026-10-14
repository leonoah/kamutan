"""Sprint 4: plumbing fixtures (detection eval subset) and the plumbing BOQ (chapter 03) implied by the fixture truth.

Fixture truth = Point features of the plumbing / hvac classes (``schema/classes.json``) on the truth sheets. The
plumbing sheets are authoritative for counts (``authoritative: true``); the same fixtures may also be annotated on
the architecture sheets (``authoritative: false``) and AC positions on the electrical sheets (AC sockets) — those
serve the detection metrics only, never the implied BOQ (that would double count).

Implied counts (default rules, mirroring the BOQ wording of the Noah sample, chapter 03):

- ``3.01`` AC condensate drain   = ac_unit
- ``3.02`` basin + WALL faucet    = basins with a ``faucet_wall`` within ``faucet_radius_mm`` (or ``faucet: wall``)
- ``3.03`` basin + DECK faucet    = the other basins + kitchen sinks
- ``3.04`` concealed-cistern WC   = fixture_wc_concealed
- ``3.05`` washing machine        = fixture_washing_machine
- ``3.06`` cold-water point       = garden_tap (garden tap or drinking-water/Tami-4 point)
- ``3.07`` monoblock WC           = fixture_wc_monoblock
- ``3.11`` / ``3.12`` / ``3.13``  = one per shower / bath, routed to the line whose description names the room
  (מקלחון ... הורים / אמבטיה ... כללי / מקלחון מרתף); unrouted ones are reported under ``unrouted``.
One-off lines (3.08-3.10, 3.14-3.15) have no fixture class; they are listed as ``not_derivable``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Any

from .data import Feature, Project, load_classes

FIXTURE_DOMAINS = ("plumbing", "hvac")


def fixture_classes() -> set[str]:
    return {c for c, v in load_classes().items() if v.get("domain") in FIXTURE_DOMAINS and c not in ("unknown",)}


def is_fixture(f: Feature, classes: set[str] | None = None) -> bool:
    classes = classes if classes is not None else fixture_classes()
    return f.geom_type == "Point" and f.kind == "symbol" and f.cls in classes


@dataclass(frozen=True)
class PlumbingRules:
    faucet_radius_mm: float = 5.0
    authoritative_only: bool = True


# routing of shower/bath fixtures to the per-room BOQ lines: (fixture class, floor or None, room-name keyword or None, code)
ROUTES: tuple[tuple[str, str | None, str | None, str], ...] = (
    ("fixture_shower", None, "הורים", "3.11"),
    ("fixture_bath", None, None, "3.12"),
    ("fixture_shower", "basement", None, "3.13"),
)
NOT_DERIVABLE = ("3.08", "3.09", "3.10", "3.14", "3.15")


def _room_name(truth: Project, sheet_id: str, room_id: Any) -> str:
    sh = truth.sheets.get(sheet_id)
    if sh is None or room_id is None:
        return ""
    for f in sh.features:
        if f.cls == "room" and f.get("room_id") == room_id:
            return " ".join(str(n) for n in (f.get("names") or [f.get("name") or ""]))
    return ""


def implied_plumbing(truth: Project, rules: PlumbingRules | None = None) -> dict[str, Any]:
    rules = rules or PlumbingRules()
    classes = fixture_classes()
    feats = [
        f
        for sh in truth.sheets.values()
        for f in sh.features
        if is_fixture(f, classes) and (not rules.authoritative_only or f.get("authoritative") is True)
    ]
    counts: dict[str, int] = {}
    evidence: dict[str, list[str]] = {}

    def add(code: str, f: Feature) -> None:
        counts[code] = counts.get(code, 0) + 1
        evidence.setdefault(code, []).append(f.id)

    faucets = [f for f in feats if f.cls == "faucet_wall"]
    unrouted: list[str] = []
    for f in feats:
        if f.cls == "ac_unit":
            add("3.01", f)
        elif f.cls == "fixture_basin":
            wall = f.get("faucet") == "wall" or any(
                g.sheet_id == f.sheet_id and math.dist(g.center, f.center) <= rules.faucet_radius_mm for g in faucets
            )
            add("3.02" if wall else "3.03", f)
        elif f.cls == "fixture_kitchen_sink":
            add("3.03", f)
        elif f.cls == "fixture_wc_concealed":
            add("3.04", f)
        elif f.cls == "fixture_washing_machine":
            add("3.05", f)
        elif f.cls == "garden_tap":
            add("3.06", f)
        elif f.cls == "fixture_wc_monoblock":
            add("3.07", f)
        elif f.cls in ("fixture_shower", "fixture_bath"):
            name = _room_name(truth, f.sheet_id, f.get("room_id"))
            code = next(
                (
                    c
                    for cls, fl, kw, c in ROUTES
                    if cls == f.cls and (fl is None or f.get("floor") == fl) and (kw is None or kw in name)
                ),
                None,
            )
            if code is None:
                unrouted.append(f.id)
            else:
                add(code, f)
    return {
        "counts": dict(sorted(counts.items())),
        "evidence": {k: sorted(v) for k, v in sorted(evidence.items())},
        "unrouted": sorted(unrouted),
        "not_derivable": list(NOT_DERIVABLE),
        "n_fixtures": len(feats),
        "rules": {"faucet_radius_mm": rules.faucet_radius_mm, "authoritative_only": rules.authoritative_only},
    }


def compare_implied(truth: Project, implied: dict[str, Any], chapter: str = "3.") -> list[dict[str, Any]]:
    disputed = truth.open_dispute_codes()
    rows = []
    for ln in truth.boq_lines():
        code = ln["code"]
        if not code.startswith(chapter):
            continue
        q = float(ln.get("quantity") or 0.0)
        derivable = code not in implied["not_derivable"]
        imp = implied["counts"].get(code, 0) if derivable else None
        rows.append(
            {
                "code": code,
                "description": ln.get("description"),
                "boq": q,
                "implied": imp,
                "diff": (imp - q) if imp is not None else None,
                "disputed": code in disputed,
                "dispute_id": ln.get("dispute_id"),
                "evidence": implied["evidence"].get(code, []),
            }
        )
    return rows


def fixture_subset(proj: Project, classes: set[str] | None = None) -> Project:
    """Same project restricted to fixture Point features (+ room polygons, used for room-id remapping)."""
    from .data import Sheet

    classes = classes if classes is not None else fixture_classes()
    out = Project(root=proj.root, boq=None, disputes=None)
    for sid, sh in proj.sheets.items():
        feats = []
        for f in sh.features:
            if is_fixture(f, classes):
                # fixtures have no legend glyph: the glyph level is the class itself
                feats.append(replace(f, props=f.props | {"symbol_class": f.cls}))
            elif f.cls == "room":
                feats.append(f)
        out.sheets[sid] = Sheet(sheet_id=sid, meta=sh.meta, features=feats)
    return out


def render_implied_markdown(rows: list[dict[str, Any]], implied: dict[str, Any]) -> str:
    out = [
        "| code | BOQ | implied | diff | disputed | description |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        imp = "n/a (one-off)" if r["implied"] is None else f"{r['implied']:g}"
        diff = "" if r["diff"] is None else f"{r['diff']:+g}"
        out.append(f"| {r['code']} | {r['boq']:g} | {imp} | {diff} | {r['dispute_id'] or ''} | {str(r['description'])[:60]} |")
    if implied["unrouted"]:
        out.append("")
        out.append("Unrouted shower/bath fixtures: " + ", ".join(implied["unrouted"]))
    return "\n".join(out) + "\n"
